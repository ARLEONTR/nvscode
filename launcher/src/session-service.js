const crypto = require('node:crypto')
const net = require('node:net')
const jwt = require('jsonwebtoken')
const { clamp } = require('./config')

const CODE_SERVER_ENTRYPOINT = [
  '--bind-addr',
  '0.0.0.0:8080',
  '--auth',
  'none',
  '--disable-telemetry',
  '--disable-update-check',
  '/workspace',
]

const CODE_SERVER_HOME_PATH = '/tmp'
const CODE_SERVER_CONFIG_PATH = '/nvscode/config'
const CODE_SERVER_DATA_PATH = '/nvscode/data'
const CODE_SERVER_STATE_LAYOUT_VERSION = '2'

class SessionService {
  constructor({ docker, config, now = () => Date.now(), waitForCodeServerReady = defaultWaitForCodeServerReady }) {
    this.docker = docker
    this.config = config
    this.now = now
    this.waitForCodeServerReady = waitForCodeServerReady
    this.activity = new Map()
    this.codeServerRunAsByUser = new Map()
    this.cleanupTimer = null
    this.fileScanTimer = null
  }

  startCleanupLoop() {
    if (this.cleanupTimer) {
      return
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleContainers().catch(() => {})
    }, this.config.cleanupIntervalSeconds * 1000)

    if (!this.fileScanTimer) {
      this.fileScanTimer = setInterval(() => {
        this.scanActiveUsers().catch(() => {})
      }, this.config.fileScanIntervalSeconds * 1000)
    }
  }

  stopCleanupLoop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    if (this.fileScanTimer) {
      clearInterval(this.fileScanTimer)
      this.fileScanTimer = null
    }
  }

  async createSession(requestBody) {
    const userId = typeof requestBody.userId === 'string' ? requestBody.userId.trim() : ''
    const workspacePath = typeof requestBody.workspacePath === 'string' ? normalizeWorkspacePath(requestBody.workspacePath) : '/'
    const filePath = typeof requestBody.filePath === 'string' && requestBody.filePath !== ''
      ? normalizeWorkspacePath(requestBody.filePath)
      : null
    const sessionTtlSeconds = clamp(parseOptionalInt(requestBody.sessionTtlSeconds, this.config.defaultSessionTtlSeconds), 300, 86400)
    const idleTimeoutSeconds = clamp(parseOptionalInt(requestBody.idleTimeoutSeconds, this.config.defaultIdleTimeoutSeconds), 300, 86400)
    const codeServerImage = sanitizeImage(requestBody.codeServerImage, this.config.codeServerImage)

    if (!isSafeUserId(userId)) {
      throw new Error('Invalid userId')
    }

    await this.ensureCodeServer(userId, codeServerImage)
    this.touchActivity(userId, idleTimeoutSeconds, workspacePath)

    const token = jwt.sign({ userId, idleTimeoutSeconds }, this.config.sessionSigningSecret, {
      expiresIn: sessionTtlSeconds,
      issuer: 'nvscode-launcher',
    })

    const query = new URLSearchParams()
    query.set('folder', workspaceToContainerPath(workspacePath))
    if (filePath) {
      query.set('file', workspaceToContainerPath(filePath))
    }

    return {
      iframePath: `/apps/nvscode/proxy/session/${token}/?${query.toString()}`,
      expiresAt: new Date(this.now() + (sessionTtlSeconds * 1000)).toISOString(),
    }
  }

  async resolveProxyTarget(token) {
    const session = jwt.verify(token, this.config.sessionSigningSecret, { issuer: 'nvscode-launcher' })
    const userId = typeof session.userId === 'string' ? session.userId : ''
    const idleTimeoutSeconds = clamp(parseOptionalInt(session.idleTimeoutSeconds, this.config.defaultIdleTimeoutSeconds), 300, 86400)

    if (!isSafeUserId(userId)) {
      throw new Error('Invalid userId')
    }

    const containerName = await this.ensureCodeServer(userId, this.config.codeServerImage)
    this.touchActivity(userId, idleTimeoutSeconds)

    return `http://${containerName}:8080`
  }

  async cleanupIdleContainers() {
    const now = this.now()
    const users = Array.from(this.activity.keys())

    for (const userId of users) {
      const record = this.activity.get(userId)
      if (!record || (record.lastSeenAt + (record.idleTimeoutSeconds * 1000)) > now) {
        continue
      }

      const container = this.docker.getContainer(sanitizeContainerName(userId, this.config.codeServerContainerPrefix))

      try {
        const details = await container.inspect()
        if (details.State.Running) {
          await container.stop({ t: 15 })
        }
      } catch (_error) {
      }

      this.activity.delete(userId)
    }
  }

  async scanActiveUsers() {
    const now = this.now()
    const scanIntervalMs = this.config.fileScanIntervalSeconds * 1000
    const users = Array.from(this.activity.entries())

    for (const [userId, record] of users) {
      if (!record) {
        continue
      }

      if ((record.lastScannedAt + scanIntervalMs) > now) {
        continue
      }

      await this.scanUserFiles(userId, record.workspacePath || '/')
      this.activity.set(userId, {
        ...record,
        lastScannedAt: now,
      })
    }
  }

  touchActivity(userId, idleTimeoutSeconds, workspacePath = null) {
    const existing = this.activity.get(userId)
    this.activity.set(userId, {
      lastSeenAt: this.now(),
      lastScannedAt: existing ? existing.lastScannedAt : 0,
      idleTimeoutSeconds,
      workspacePath: workspacePath ?? (existing ? existing.workspacePath : '/'),
    })
  }

  async scanUserFiles(userId, workspacePath) {
    const container = await this.getNextcloudContainer()
    const scanPath = buildNextcloudScanPath(userId, workspacePath)
    const exec = await container.exec({
      AttachStdout: true,
      AttachStderr: true,
      User: this.config.nextcloudExecUser,
      WorkingDir: this.config.nextcloudExecWorkingDir,
      Cmd: ['sh', '-lc', buildNextcloudScanCommand(this.config.nextcloudOccCommand, scanPath)],
    })

    await new Promise((resolve, reject) => {
      exec.start((error, stream) => {
        if (error) {
          reject(error)
          return
        }

        if (!stream) {
          resolve()
          return
        }

        stream.on('end', resolve)
        stream.on('error', reject)
        stream.resume()
      })
    })

    const inspect = await exec.inspect()
    if (inspect.ExitCode !== 0) {
      throw new Error(`Nextcloud file scan failed with exit code ${inspect.ExitCode}`)
    }
  }

  async getNextcloudContainer() {
    if (this.config.nextcloudContainerName) {
      const container = this.docker.getContainer(this.config.nextcloudContainerName)

      try {
        await container.inspect()
        return container
      } catch (error) {
        if (error.statusCode !== 404) {
          throw error
        }
      }
    }

    if (!this.config.nextcloudContainerLabel) {
      throw new Error('Nextcloud container not found. Configure NEXTCLOUD_CONTAINER_NAME or NEXTCLOUD_CONTAINER_LABEL.')
    }

    const containers = await this.docker.listContainers({
      all: true,
      filters: {
        label: [this.config.nextcloudContainerLabel],
      },
    })

    if (containers.length === 0) {
      throw new Error(`Nextcloud container not found. Checked NEXTCLOUD_CONTAINER_NAME=${this.config.nextcloudContainerName || '<unset>'} and NEXTCLOUD_CONTAINER_LABEL=${this.config.nextcloudContainerLabel}.`)
    }

    return this.docker.getContainer(containers[0].Id)
  }

  async ensureCodeServer(userId, image) {
    const containerName = sanitizeContainerName(userId, this.config.codeServerContainerPrefix)
    const container = this.docker.getContainer(containerName)
    const workspacePath = userFilesHostPath(userId, this.config.nextcloudDataHostPath)
    const configPath = userConfigHostPath(userId, this.config.launcherStateHostPath)
    const dataPath = userDataHostPath(userId, this.config.launcherStateHostPath)

    await ensureImage(this.docker, image)
    const runtimeOwner = await this.resolveCodeServerRunAs(userId, image, workspacePath)

    try {
      const details = await container.inspect()
      if (isCodeServerContainerCompatible(details, {
        runtimeOwner,
        workspacePath,
        configPath,
        dataPath,
      })) {
        await ensureWritableStateDirectories(this.docker, image, {
          configPath,
          dataPath,
          stateOwner: runtimeOwner,
        })

        if (!details.State.Running) {
          await container.start()
        }

        await this.waitForCodeServerReady(containerName)
        return containerName
      }

      await stopAndRemoveContainer(container, details)
    } catch (error) {
      if (error.statusCode !== 404) {
        throw error
      }
    }

    await ensureWritableStateDirectories(this.docker, image, {
      configPath,
      dataPath,
      stateOwner: runtimeOwner,
    })

    const created = await this.docker.createContainer({
      name: containerName,
      Image: image,
      User: runtimeOwner,
      Entrypoint: ['sh', '-lc'],
      Cmd: [buildCodeServerStartupCommand()],
      Env: [
        `HOME=${CODE_SERVER_HOME_PATH}`,
        `XDG_CONFIG_HOME=${CODE_SERVER_CONFIG_PATH}`,
        `XDG_DATA_HOME=${CODE_SERVER_DATA_PATH}`,
        `CODE_SERVER_DEFAULT_EXTENSIONS=${this.config.codeServerDefaultExtensions.join(',')}`,
      ],
      Labels: {
        'com.nvscode.role': 'code-server',
        'com.nvscode.user': userId,
        'com.nvscode.run-as': runtimeOwner,
        'com.nvscode.state-layout': CODE_SERVER_STATE_LAYOUT_VERSION,
      },
      HostConfig: {
        AutoRemove: false,
        Binds: [
          `${workspacePath}:/workspace`,
          `${configPath}:${CODE_SERVER_CONFIG_PATH}`,
          `${dataPath}:${CODE_SERVER_DATA_PATH}`,
        ],
        NetworkMode: this.config.dockerNetworkName,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    })

    await created.start()
    await this.waitForCodeServerReady(containerName)

    return containerName
  }

  async resolveCodeServerRunAs(userId, image, workspacePath) {
    const cachedOwner = this.codeServerRunAsByUser.get(userId)
    if (cachedOwner) {
      return cachedOwner
    }

    const resolvedOwner = await resolveWorkspaceOwner(this.docker, image, workspacePath, this.config.codeServerRunAs)
    this.codeServerRunAsByUser.set(userId, resolvedOwner)
    return resolvedOwner
  }
}

async function ensureWritableStateDirectories(docker, image, { configPath, dataPath, stateOwner }) {
  const initContainer = await docker.createContainer({
    Image: image,
    User: '0:0',
    Entrypoint: ['sh', '-lc'],
    Cmd: [`mkdir -p /config /data && chown -R ${stateOwner} /config /data`],
    HostConfig: {
      AutoRemove: true,
      Binds: [
        `${configPath}:/config`,
        `${dataPath}:/data`,
      ],
    },
  })

  await initContainer.start()
  const result = await initContainer.wait()

  if (result.StatusCode !== 0) {
    throw new Error(`Failed to prepare code-server state directories at ${configPath} and ${dataPath}`)
  }
}

async function resolveWorkspaceOwner(docker, image, workspacePath, fallbackOwner) {
  const probeContainer = await docker.createContainer({
    Image: image,
    User: '0:0',
    Tty: true,
    Entrypoint: ['sh', '-lc'],
    Cmd: ['stat -c %u:%g /workspace-user-files'],
    HostConfig: {
      AutoRemove: false,
      Binds: [`${workspacePath}:/workspace-user-files:ro`],
    },
  })

  try {
    await probeContainer.start()
    const result = await probeContainer.wait()
    const output = String(await probeContainer.logs({ stdout: true, stderr: true })).trim()

    if (result.StatusCode !== 0) {
      return fallbackOwner
    }

    return parseUidGidOutput(output, fallbackOwner)
  } finally {
    try {
      await probeContainer.remove({ force: true })
    } catch (_error) {
    }
  }
}

function parseUidGidOutput(output, fallbackOwner) {
  const match = String(output).trim().match(/^(\d+:\d+)$/)
  return match ? match[1] : fallbackOwner
}

function buildNextcloudScanCommand(occCommand, scanPath) {
  return `${occCommand} files:scan ${shellQuote(`--path=${scanPath}`)}`
}

function normalizeContainerUser(value) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return /^\d+:\d+$/.test(normalized) ? normalized : ''
}

function isCodeServerContainerCompatible(details, { runtimeOwner, workspacePath, configPath, dataPath }) {
  if (normalizeContainerUser(details && details.Config && details.Config.User) !== runtimeOwner) {
    return false
  }

  const labels = (details && details.Config && details.Config.Labels) || {}
  if (labels['com.nvscode.state-layout'] !== CODE_SERVER_STATE_LAYOUT_VERSION) {
    return false
  }

  const env = new Set((details && details.Config && details.Config.Env) || [])
  const binds = new Set((details && details.HostConfig && details.HostConfig.Binds) || [])

  return env.has(`HOME=${CODE_SERVER_HOME_PATH}`)
    && env.has(`XDG_CONFIG_HOME=${CODE_SERVER_CONFIG_PATH}`)
    && env.has(`XDG_DATA_HOME=${CODE_SERVER_DATA_PATH}`)
    && binds.has(`${workspacePath}:/workspace`)
    && binds.has(`${configPath}:${CODE_SERVER_CONFIG_PATH}`)
    && binds.has(`${dataPath}:${CODE_SERVER_DATA_PATH}`)
}

async function stopAndRemoveContainer(container, details) {
  if (details && details.State && details.State.Running) {
    await container.stop({ t: 15 })
  }

  await container.remove({ force: true })
}

function buildCodeServerStartupCommand() {
  const codeServerArgs = CODE_SERVER_ENTRYPOINT.map((arg) => shellQuote(arg)).join(' ')

  return [
    'set -eu',
    'installed_extensions="$(code-server --list-extensions 2>/dev/null || true)"',
    'if [ -n "${CODE_SERVER_DEFAULT_EXTENSIONS:-}" ]; then',
    '  OLD_IFS="$IFS"',
    "  IFS=','",
    '  for extension in $CODE_SERVER_DEFAULT_EXTENSIONS; do',
    '    if [ -z "$extension" ]; then',
    '      continue',
    '    fi',
    '    if ! printf "%s\\n" "$installed_extensions" | grep -Fxs "$extension" >/dev/null 2>&1; then',
    '      code-server --install-extension "$extension" --force',
    '    fi',
    '  done',
    '  IFS="$OLD_IFS"',
    'fi',
    ...buildCodeServerSettingsCommand(),
    ...buildTinymistPatchCommand(),
    `exec code-server ${codeServerArgs}`,
  ].join('\n')
}

function buildCodeServerSettingsCommand() {
  return [
    "cat <<'NVSCODE_CODE_SERVER_SETTINGS' >/tmp/nvscode-code-server-settings.js",
    'const fs = require("node:fs")',
    'const path = require("node:path")',
    'const filePath = process.argv[2]',
    'const directoryPath = path.dirname(filePath)',
    'fs.mkdirSync(directoryPath, { recursive: true })',
    'let settings = {}',
    'if (fs.existsSync(filePath)) {',
    '  try {',
    '    settings = JSON.parse(fs.readFileSync(filePath, "utf8"))',
    '  } catch (_error) {',
    '    settings = {}',
    '  }',
    '}',
    'const editorAssociations = typeof settings["workbench.editorAssociations"] === "object" && settings["workbench.editorAssociations"] !== null && !Array.isArray(settings["workbench.editorAssociations"])',
    '  ? settings["workbench.editorAssociations"]',
    '  : {}',
    'editorAssociations["*.pdf"] = "pdf.view"',
    'settings["workbench.editorAssociations"] = editorAssociations',
    'fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 4)}\\n`)',
    'NVSCODE_CODE_SERVER_SETTINGS',
    'settings_file="$XDG_DATA_HOME/code-server/User/settings.json"',
    '/usr/lib/code-server/lib/node /tmp/nvscode-code-server-settings.js "$settings_file"',
    'rm -f /tmp/nvscode-code-server-settings.js',
  ]
}

function buildTinymistPatchCommand() {
  return [
    "cat <<'NVSCODE_TINYMIST_PATCH' >/tmp/nvscode-tinymist-patch.js",
    'const fs = require("node:fs")',
    'const filePath = process.argv[2]',
    'if (!filePath || !fs.existsSync(filePath)) {',
    '  process.exit(0)',
    '}',
    'let source = fs.readFileSync(filePath, "utf8")',
    'const replaceOnce = (oldValue, newValue) => {',
    '  if (!source.includes(oldValue)) {',
    '    return',
    '  }',
    '  source = source.replace(oldValue, newValue)',
    '}',
    'if (!source.includes("async function resolveExternalUri(vscodeModule, urlStr) {")) {',
    '  replaceOnce(',
    '    [',
    '      "function translateExternalURL(urlStr) {",',
    '      "  if (isGitpod()) {",',
    '      "    return translateGitpodURL(urlStr);",',
    '      "  } else {",',
    '      "    return urlStr;",',
    '      "  }",',
    '      "}",',
    '    ].join("\\n"),',
    '    [',
    '      "function translateExternalURL(urlStr) {",',
    '      "  if (isGitpod()) {",',
    '      "    return translateGitpodURL(urlStr);",',
    '      "  } else {",',
    '      "    return urlStr;",',
    '      "  }",',
    '      "}",',
    '      "async function resolveExternalUri(vscodeModule, urlStr) {",',
    '      "  return (await vscodeModule.env.asExternalUri(vscodeModule.Uri.parse(translateExternalURL(urlStr)))).toString();",',
    '      "}",',
    '      "async function resolvePreviewWebSocketUrl(vscodeModule, port) {",',
    '      "  return toPreviewWebSocketUrl(await resolveExternalUri(vscodeModule, `http://127.0.0.1:${port}`));",',
    '      "}",',
    '      "function toPreviewWebSocketUrl(urlStr) {",',
    "      \"  return urlStr.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');\",",
    '      "}",',
    '    ].join("\\n")',
    '  )',
    '}',
    'if (!source.includes("const externalDataPlaneUrl = await resolveExternalUri(vscode6, `http://127.0.0.1:${dataPlanePort}`);")) {',
    '  replaceOnce(',
    '    [',
    '      "  html = html.replace(",',
    '      "    \\\"ws://127.0.0.1:23625\\\",",',
    '    ].join("\\n"),',
    '    [',
    '      "  const externalDataPlaneUrl = await resolveExternalUri(vscode6, `http://127.0.0.1:${dataPlanePort}`);",',
    '      "  html = html.replace(",',
    '      "    \\\"ws://127.0.0.1:23625\\\",",',
    '    ].join("\\n")',
    '  )',
    '}',
    'replaceOnce(',
    '  "    translateExternalURL(`ws://127.0.0.1:${dataPlanePort}`)",',
    '  "    toPreviewWebSocketUrl(externalDataPlaneUrl)"',
    ')',
    'replaceOnce(',
    '  [',
    '    "  panel.webview.html = html;",',
    '    "  await vscode6.env.asExternalUri(",',
    '    "    vscode6.Uri.parse(translateExternalURL(`http://127.0.0.1:${dataPlanePort}`))",',
    '    "  );",',
    '  ].join("\\n"),',
    '  "  panel.webview.html = html;"',
    ')',
    'replaceOnce(',
    '  "  let connectUrl = `ws://127.0.0.1:${dataPlanePort}`;",',
    '  "  let connectUrl = await resolvePreviewWebSocketUrl(vscode5, dataPlanePort);"',
    ')',
    'replaceOnce(',
    '  "    let connectUrl = translateExternalURL(`ws://127.0.0.1:${dataPlanePort}`);",',
    '  "    let connectUrl = await resolvePreviewWebSocketUrl(vscode6, dataPlanePort);"',
    ')',
    'replaceOnce(',
    '  "      vscode5.env.openExternal(vscode5.Uri.parse(`http://127.0.0.1:${staticFilePort2}`));",',
    '  "      vscode5.env.openExternal(vscode5.Uri.parse(await resolveExternalUri(vscode5, `http://127.0.0.1:${staticFilePort2}`)));"',
    ')',
    'replaceOnce(',
    '  "      vscode6.env.openExternal(vscode6.Uri.parse(`http://127.0.0.1:${staticServerPort}`));",',
    '  "      vscode6.env.openExternal(vscode6.Uri.parse(await resolveExternalUri(vscode6, `http://127.0.0.1:${staticServerPort}`)));"',
    ')',
    'fs.writeFileSync(filePath, source)',
    'NVSCODE_TINYMIST_PATCH',
    'find "$XDG_DATA_HOME/code-server/extensions" -maxdepth 1 -type d -name "myriad-dreamin.tinymist-*" | while IFS= read -r extension_dir; do',
    '  extension_file="$extension_dir/out/extension.js"',
    '  if [ -f "$extension_file" ]; then',
    '    /usr/lib/code-server/lib/node /tmp/nvscode-tinymist-patch.js "$extension_file" || true',
    '  fi',
    'done',
    'rm -f /tmp/nvscode-tinymist-patch.js',
  ]
}

async function ensureImage(docker, image) {
  try {
    await docker.getImage(image).inspect()
    return
  } catch (error) {
    if (error.statusCode !== 404) {
      throw error
    }
  }

  const stream = await docker.pull(image)
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(stream, (error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

async function defaultWaitForCodeServerReady(containerName, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 1000
  const retryDelayMs = options.retryDelayMs ?? 250
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      await tryConnect(containerName, 8080, attemptTimeoutMs)
      return
    } catch (_error) {
      await delay(retryDelayMs)
    }
  }

  throw new Error(`code-server did not become ready for ${containerName} within ${timeoutMs}ms`)
}

function tryConnect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let settled = false

    const finalize = (callback, value) => {
      if (settled) {
        return
      }

      settled = true
      socket.destroy()
      callback(value)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finalize(resolve))
    socket.once('timeout', () => finalize(reject, new Error('Connection timed out')))
    socket.once('error', (error) => finalize(reject, error))
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isSafeUserId(userId) {
  return /^[A-Za-z0-9_.@-]+$/.test(userId)
}

function normalizeWorkspacePath(value) {
  const parts = String(value)
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')

  for (const segment of parts) {
    if (segment === '..') {
      throw new Error('Path traversal is not allowed')
    }
  }

  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

function workspaceToContainerPath(workspacePath) {
  return workspacePath === '/' ? '/workspace' : `/workspace${workspacePath}`
}

function buildNextcloudScanPath(userId, workspacePath) {
  const normalizedPath = normalizeWorkspacePath(workspacePath)
  return normalizedPath === '/'
    ? `${userId}/files`
    : `${userId}/files${normalizedPath}`
}

function sanitizeContainerName(userId, prefix) {
  const normalizedPrefix = String(prefix).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'nvscode-code-server'
  const normalizedUser = String(userId).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user'
  const uniqueSuffix = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 12)

  return `${normalizedPrefix}-${normalizedUser}-${uniqueSuffix}`
}

function userFilesHostPath(userId, rootPath) {
  return `${rootPath}/${userId}/files`
}

function userStateHostPath(userId, rootPath) {
  return `${rootPath}/${userId}`
}

function userConfigHostPath(userId, rootPath) {
  return `${userStateHostPath(userId, rootPath)}/config`
}

function userDataHostPath(userId, rootPath) {
  return `${userStateHostPath(userId, rootPath)}/data`
}

function sanitizeImage(value, fallback) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized === '' ? fallback : normalized
}

function parseOptionalInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

module.exports = {
  buildNextcloudScanPath,
  buildNextcloudScanCommand,
  buildCodeServerStartupCommand,
  SessionService,
  ensureImage,
  ensureWritableStateDirectories,
  isCodeServerContainerCompatible,
  isSafeUserId,
  normalizeContainerUser,
  normalizeWorkspacePath,
  parseOptionalInt,
  parseUidGidOutput,
  resolveWorkspaceOwner,
  sanitizeContainerName,
  sanitizeImage,
  stopAndRemoveContainer,
  userConfigHostPath,
  userDataHostPath,
  userFilesHostPath,
  userStateHostPath,
  workspaceToContainerPath,
  defaultWaitForCodeServerReady,
}

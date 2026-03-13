const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const {
  buildNextcloudScanPath,
  buildCodeServerStartupCommand,
  SessionService,
  normalizeWorkspacePath,
  sanitizeContainerName,
  userConfigHostPath,
  userDataHostPath,
  userFilesHostPath,
  userStateHostPath,
  workspaceToContainerPath,
} = require('../src/session-service')

test('normalizeWorkspacePath blocks traversal and preserves root', () => {
  assert.equal(normalizeWorkspacePath('/'), '/')
  assert.equal(normalizeWorkspacePath('/Documents/demo'), '/Documents/demo')
  assert.throws(() => normalizeWorkspacePath('../etc/passwd'), /Path traversal/)
})

test('path helpers derive stable mount points', () => {
  assert.equal(workspaceToContainerPath('/'), '/workspace')
  assert.equal(workspaceToContainerPath('/Docs'), '/workspace/Docs')
  assert.match(sanitizeContainerName('Alice.Example', 'code'), /^code-alice-example-[a-f0-9]{12}$/)
  assert.notEqual(
    sanitizeContainerName('Alice.Example', 'code'),
    sanitizeContainerName('alice-example', 'code')
  )
  assert.equal(userFilesHostPath('alice', '/data'), '/data/alice/files')
  assert.equal(userStateHostPath('alice', '/state'), '/state/alice')
  assert.equal(userConfigHostPath('alice', '/state'), '/state/alice/config')
  assert.equal(userDataHostPath('alice', '/state'), '/state/alice/data')
  assert.equal(buildNextcloudScanPath('alice', '/'), 'alice/files')
  assert.equal(buildNextcloudScanPath('alice', '/Documents'), 'alice/files/Documents')
})

test('buildCodeServerStartupCommand installs default extensions before startup', () => {
  const command = buildCodeServerStartupCommand()

  assert.match(command, /CODE_SERVER_DEFAULT_EXTENSIONS/)
  assert.match(command, /code-server --install-extension/)
  assert.match(command, /nvscode-code-server-settings/)
  assert.match(command, /pdf\.view/)
  assert.match(command, /nvscode-tinymist-patch/)
  assert.match(command, /resolvePreviewWebSocketUrl/)
  assert.match(command, /exec code-server/)
})

test('createSession provisions a container with workspace and state mounts', async () => {
  const createdSpecs = []
  const createdContainer = {
    start: async () => {},
    wait: async () => ({ StatusCode: 0 }),
  }
  const docker = {
    modem: {
      followProgress: (_stream, callback) => callback(),
    },
    getImage: () => ({
      inspect: async () => {
        const error = new Error('not found')
        error.statusCode = 404
        throw error
      },
    }),
    pull: async () => ({}),
    getContainer: () => ({
      inspect: async () => {
        const error = new Error('not found')
        error.statusCode = 404
        throw error
      },
    }),
    createContainer: async (spec) => {
      createdSpecs.push(spec)
      return createdContainer
    },
  }

  const service = new SessionService({
    docker,
    config: {
      sessionSigningSecret: 'secret',
      defaultSessionTtlSeconds: 1800,
      defaultIdleTimeoutSeconds: 900,
      cleanupIntervalSeconds: 60,
      nextcloudDataHostPath: '/srv/nextcloud-data',
      launcherStateHostPath: '/srv/launcher-state',
      dockerNetworkName: 'nvscode_default',
      codeServerImage: 'nvscode-code-server:latest',
      codeServerRunAs: '33:33',
      codeServerContainerPrefix: 'nvscode-code-server',
      codeServerDefaultExtensions: ['myriad-dreamin.tinymist', 'mathematic.vscode-pdf'],
      fileScanIntervalSeconds: 15,
    },
    now: () => 1_700_000_000_000,
    waitForCodeServerReady: async () => {},
  })

  const session = await service.createSession({
    userId: 'alice',
    workspacePath: '/Documents/Project',
    filePath: '/Documents/Project/index.js',
    idleTimeoutSeconds: 1200,
  })

  assert.equal(createdSpecs.length, 2)
  assert.equal(createdSpecs[0].User, '0:0')
  assert.match(createdSpecs[0].Cmd[0], /chown -R 33:33 \/config \/data/)
  assert.deepEqual(createdSpecs[0].HostConfig.Binds, [
    '/srv/launcher-state/alice/config:/config',
    '/srv/launcher-state/alice/data:/data',
  ])
  assert.equal(createdSpecs[1].User, '33:33')
  assert.deepEqual(createdSpecs[1].HostConfig.Binds, [
    '/srv/nextcloud-data/alice/files:/workspace',
    '/srv/launcher-state/alice/config:/home/coder/.config',
    '/srv/launcher-state/alice/data:/home/coder/.local/share/code-server',
  ])
  assert.deepEqual(createdSpecs[1].Entrypoint, ['sh', '-lc'])
  assert.match(createdSpecs[1].Cmd[0], /exec code-server/)
  assert.match(createdSpecs[1].Env.join('\n'), /CODE_SERVER_DEFAULT_EXTENSIONS=myriad-dreamin\.tinymist,mathematic\.vscode-pdf/)
  assert.match(session.iframePath, /^\/apps\/nvscode\/proxy\/session\//)

  const token = session.iframePath.split('/')[5]
  const decoded = jwt.verify(token, 'secret', { issuer: 'nvscode-launcher' })
  assert.equal(decoded.userId, 'alice')
  assert.equal(decoded.idleTimeoutSeconds, 1200)
})

test('cleanupIdleContainers stops stale running containers', async () => {
  let stopped = false
  const docker = {
    getContainer: () => ({
      inspect: async () => ({ State: { Running: true } }),
      stop: async () => {
        stopped = true
      },
    }),
  }

  const service = new SessionService({
    docker,
    config: {
      sessionSigningSecret: 'secret',
      defaultSessionTtlSeconds: 1800,
      defaultIdleTimeoutSeconds: 600,
      cleanupIntervalSeconds: 60,
      nextcloudDataHostPath: '/srv/nextcloud-data',
      launcherStateHostPath: '/srv/launcher-state',
      dockerNetworkName: 'nvscode_default',
      codeServerImage: 'nvscode-code-server:latest',
      codeServerRunAs: '1000:1000',
      codeServerContainerPrefix: 'nvscode-code-server',
      codeServerDefaultExtensions: ['myriad-dreamin.tinymist', 'mathematic.vscode-pdf'],
      fileScanIntervalSeconds: 15,
    },
    now: () => 10_000,
    waitForCodeServerReady: async () => {},
  })

  service.activity.set('alice', { lastSeenAt: 0, idleTimeoutSeconds: 5 })
  await service.cleanupIdleContainers()

  assert.equal(stopped, true)
  assert.equal(service.activity.has('alice'), false)
})

test('scanActiveUsers rescans active workspace paths through the Nextcloud container', async () => {
  const commands = []
  const docker = {
    listContainers: async () => [{ Id: 'nextcloud-id' }],
    getContainer: (id) => {
      if (id === 'nextcloud-id') {
        return {
          exec: async ({ Cmd }) => ({
            start: (callback) => {
              commands.push(Cmd)
              callback(null, {
                on(event, handler) {
                  if (event === 'end') {
                    handler()
                  }
                },
                resume() {},
              })
            },
            inspect: async () => ({ ExitCode: 0 }),
          }),
        }
      }

      return {
        inspect: async () => ({ State: { Running: true } }),
        stop: async () => {},
      }
    },
  }

  const service = new SessionService({
    docker,
    config: {
      sessionSigningSecret: 'secret',
      defaultSessionTtlSeconds: 1800,
      defaultIdleTimeoutSeconds: 600,
      cleanupIntervalSeconds: 60,
      fileScanIntervalSeconds: 15,
      nextcloudDataHostPath: '/srv/nextcloud-data',
      launcherStateHostPath: '/srv/launcher-state',
      dockerNetworkName: 'nvscode_default',
      codeServerImage: 'nvscode-code-server:latest',
      codeServerRunAs: '1000:1000',
      codeServerContainerPrefix: 'nvscode-code-server',
      codeServerDefaultExtensions: ['myriad-dreamin.tinymist', 'mathematic.vscode-pdf'],
    },
    now: () => 20_000,
    waitForCodeServerReady: async () => {},
  })

  service.activity.set('alice', {
    lastSeenAt: 20_000,
    lastScannedAt: 0,
    idleTimeoutSeconds: 600,
    workspacePath: '/Documents',
  })

  await service.scanActiveUsers()

  assert.deepEqual(commands[0], ['php', 'occ', 'files:scan', '--path=alice/files/Documents'])
  assert.equal(service.activity.get('alice').lastScannedAt, 20_000)
})

test('ensureCodeServer waits for readiness before returning a new container', async () => {
  const events = []
  const docker = {
    modem: {
      followProgress: (_stream, callback) => callback(),
    },
    getImage: () => ({
      inspect: async () => ({ Id: 'image-id' }),
    }),
    getContainer: () => ({
      inspect: async () => {
        const error = new Error('not found')
        error.statusCode = 404
        throw error
      },
    }),
    createContainer: async (spec) => {
      if (spec.User === '0:0') {
        return {
          start: async () => {
            events.push('prepare-start')
          },
          wait: async () => {
            events.push('prepare-ready')
            return { StatusCode: 0 }
          },
        }
      }

      return {
        start: async () => {
          events.push('start')
        },
      }
    },
  }

  const service = new SessionService({
    docker,
    config: {
      sessionSigningSecret: 'secret',
      defaultSessionTtlSeconds: 1800,
      defaultIdleTimeoutSeconds: 900,
      cleanupIntervalSeconds: 60,
      nextcloudDataHostPath: '/srv/nextcloud-data',
      launcherStateHostPath: '/srv/launcher-state',
      dockerNetworkName: 'nvscode_default',
      codeServerImage: 'nvscode-code-server:latest',
      codeServerRunAs: '1000:1000',
      codeServerContainerPrefix: 'nvscode-code-server',
      codeServerDefaultExtensions: ['myriad-dreamin.tinymist', 'mathematic.vscode-pdf'],
      fileScanIntervalSeconds: 15,
    },
    waitForCodeServerReady: async () => {
      events.push('ready')
    },
  })

  const containerName = await service.ensureCodeServer('alice', 'nvscode-code-server:latest')

  assert.match(containerName, /^nvscode-code-server-alice-[a-f0-9]{12}$/)
  assert.deepEqual(events, ['prepare-start', 'prepare-ready', 'start', 'ready'])
})
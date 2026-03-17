const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const {
  buildNextcloudScanCommand,
  buildNextcloudScanPath,
  buildCodeServerStartupCommand,
  isCodeServerContainerCompatible,
  parseUidGidOutput,
  resolveWorkspaceOwner,
  SessionService,
  normalizeWorkspacePath,
  sanitizeContainerName,
  stopAndRemoveContainer,
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
  assert.equal(buildNextcloudScanCommand('php occ', 'alice/files/Documents'), "php occ files:scan '--path=alice/files/Documents'")
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
  assert.match(command, /CODE_SERVER_FORCE_EXTENSION_UPDATES/)
  assert.match(command, /code-server --install-extension/)
  assert.match(command, /nvscode-code-server-settings/)
  assert.match(command, /XDG_DATA_HOME\/code-server\/User\/settings\.json/)
  assert.match(command, /pdf\.view/)
  assert.match(command, /nvscode-tinymist-patch/)
  assert.match(command, /resolvePreviewWebSocketUrl/)
  assert.match(command, /exec code-server/)
})

test('isCodeServerContainerCompatible validates the expected state layout', () => {
  assert.equal(isCodeServerContainerCompatible({
    Config: {
      User: '2001:3001',
      Labels: { 'com.nvscode.state-layout': '2' },
      Env: [
        'HOME=/tmp',
        'XDG_CONFIG_HOME=/nvscode/config',
        'XDG_DATA_HOME=/nvscode/data',
        'CODE_SERVER_FORCE_EXTENSION_UPDATES=false',
      ],
    },
    HostConfig: {
      Binds: [
        '/srv/nextcloud-data/alice/files:/workspace',
        '/srv/launcher-state/alice/config:/nvscode/config',
        '/srv/launcher-state/alice/data:/nvscode/data',
      ],
    },
  }, {
    runtimeOwner: '2001:3001',
    workspacePath: '/srv/nextcloud-data/alice/files',
    configPath: '/srv/launcher-state/alice/config',
    dataPath: '/srv/launcher-state/alice/data',
    forceExtensionUpdates: false,
  }), true)
})

test('resolveWorkspaceOwner parses uid and gid from a mounted workspace probe', async () => {
  let removed = false
  const docker = {
    createContainer: async (spec) => {
      assert.deepEqual(spec.HostConfig.Binds, ['/srv/nextcloud-data/alice/files:/workspace-user-files:ro'])
      return {
        start: async () => {},
        wait: async () => ({ StatusCode: 0 }),
        logs: async () => Buffer.from('2001:3001\n'),
        remove: async () => {
          removed = true
        },
      }
    },
  }

  const runAs = await resolveWorkspaceOwner(docker, 'nvscode-code-server:latest', '/srv/nextcloud-data/alice/files', '33:33')

  assert.equal(runAs, '2001:3001')
  assert.equal(removed, true)
})

test('parseUidGidOutput falls back when the probe output is not usable', () => {
  assert.equal(parseUidGidOutput('not-a-uidgid', '33:33'), '33:33')
})

test('createSession provisions a container with workspace and state mounts', async () => {
  const createdSpecs = []
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
      if (spec.Cmd[0] === 'stat -c %u:%g /workspace-user-files') {
        return {
          start: async () => {},
          wait: async () => ({ StatusCode: 0 }),
          logs: async () => Buffer.from('2001:3001\n'),
          remove: async () => {},
        }
      }

      return {
        start: async () => {},
        wait: async () => ({ StatusCode: 0 }),
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

  assert.equal(createdSpecs.length, 3)
  assert.equal(createdSpecs[0].User, '0:0')
  assert.equal(createdSpecs[0].Cmd[0], 'stat -c %u:%g /workspace-user-files')
  assert.deepEqual(createdSpecs[0].HostConfig.Binds, [
    '/srv/nextcloud-data/alice/files:/workspace-user-files:ro',
  ])
  assert.equal(createdSpecs[1].User, '0:0')
  assert.match(createdSpecs[1].Cmd[0], /chown -R 2001:3001 \/config \/data/)
  assert.deepEqual(createdSpecs[1].HostConfig.Binds, [
    '/srv/launcher-state/alice/config:/config',
    '/srv/launcher-state/alice/data:/data',
  ])
  assert.equal(createdSpecs[2].User, '2001:3001')
  assert.deepEqual(createdSpecs[2].HostConfig.Binds, [
    '/srv/nextcloud-data/alice/files:/workspace',
    '/srv/launcher-state/alice/config:/nvscode/config',
    '/srv/launcher-state/alice/data:/nvscode/data',
  ])
  assert.deepEqual(createdSpecs[2].Entrypoint, ['sh', '-lc'])
  assert.match(createdSpecs[2].Cmd[0], /exec code-server/)
  assert.match(createdSpecs[2].Env.join('\n'), /CODE_SERVER_DEFAULT_EXTENSIONS=myriad-dreamin\.tinymist,mathematic\.vscode-pdf/)
  assert.match(createdSpecs[2].Env.join('\n'), /HOME=\/tmp/)
  assert.match(createdSpecs[2].Env.join('\n'), /XDG_CONFIG_HOME=\/nvscode\/config/)
  assert.match(createdSpecs[2].Env.join('\n'), /XDG_DATA_HOME=\/nvscode\/data/)
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
      nextcloudContainerName: '',
      nextcloudContainerLabel: 'com.docker.compose.service=nextcloud',
      nextcloudExecUser: 'www-data',
      nextcloudExecWorkingDir: '/var/www/html',
      nextcloudOccCommand: 'php occ',
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

  assert.deepEqual(commands[0], ['sh', '-lc', "php occ files:scan '--path=alice/files/Documents'"])
  assert.equal(service.activity.get('alice').lastScannedAt, 20_000)
})

test('scanActiveUsers can target a configured Nextcloud container name', async () => {
  const commands = []
  const docker = {
    getContainer: (id) => ({
      inspect: async () => ({ Id: id, State: { Running: true } }),
      exec: async ({ Cmd, User, WorkingDir }) => ({
        start: (callback) => {
          commands.push({ Cmd, User, WorkingDir, id })
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
    }),
  }

  const service = new SessionService({
    docker,
    config: {
      sessionSigningSecret: 'secret',
      defaultSessionTtlSeconds: 1800,
      defaultIdleTimeoutSeconds: 600,
      cleanupIntervalSeconds: 60,
      fileScanIntervalSeconds: 15,
      nextcloudContainerName: 'custom-nextcloud',
      nextcloudContainerLabel: '',
      nextcloudExecUser: 'apache',
      nextcloudExecWorkingDir: '/var/www/nextcloud',
      nextcloudOccCommand: 'sudo -u www-data php occ',
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

  assert.deepEqual(commands[0], {
    id: 'custom-nextcloud',
    User: 'apache',
    WorkingDir: '/var/www/nextcloud',
    Cmd: ['sh', '-lc', "sudo -u www-data php occ files:scan '--path=alice/files/Documents'"],
  })
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
      if (spec.Cmd[0] === 'stat -c %u:%g /workspace-user-files') {
        return {
          start: async () => {
            events.push('probe-start')
          },
          wait: async () => {
            events.push('probe-ready')
            return { StatusCode: 0 }
          },
          logs: async () => Buffer.from('2001:3001\n'),
          remove: async () => {
            events.push('probe-remove')
          },
        }
      }

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
      nextcloudContainerName: '',
      nextcloudContainerLabel: 'com.docker.compose.service=nextcloud',
      nextcloudExecUser: 'www-data',
      nextcloudExecWorkingDir: '/var/www/html',
      nextcloudOccCommand: 'php occ',
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
  assert.deepEqual(events, ['probe-start', 'probe-ready', 'probe-remove', 'prepare-start', 'prepare-ready', 'start', 'ready'])
})

test('ensureCodeServer recreates containers whose configured user no longer matches the workspace owner', async () => {
  const events = []
  const container = {
    inspect: async () => ({
      Config: { User: '33:33' },
      State: { Running: true },
    }),
    stop: async () => {
      events.push('stop')
    },
    remove: async () => {
      events.push('remove')
    },
  }
  const docker = {
    modem: {
      followProgress: (_stream, callback) => callback(),
    },
    getImage: () => ({
      inspect: async () => ({ Id: 'image-id' }),
    }),
    getContainer: () => container,
    createContainer: async (spec) => {
      if (spec.Cmd[0] === 'stat -c %u:%g /workspace-user-files') {
        return {
          start: async () => {},
          wait: async () => ({ StatusCode: 0 }),
          logs: async () => Buffer.from('2001:3001\n'),
          remove: async () => {},
        }
      }

      if (spec.User === '0:0') {
        return {
          start: async () => {},
          wait: async () => ({ StatusCode: 0 }),
        }
      }

      events.push(`create:${spec.User}`)
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
      nextcloudContainerName: '',
      nextcloudContainerLabel: 'com.docker.compose.service=nextcloud',
      nextcloudExecUser: 'www-data',
      nextcloudExecWorkingDir: '/var/www/html',
      nextcloudOccCommand: 'php occ',
      nextcloudDataHostPath: '/srv/nextcloud-data',
      launcherStateHostPath: '/srv/launcher-state',
      dockerNetworkName: 'nvscode_default',
      codeServerImage: 'nvscode-code-server:latest',
      codeServerRunAs: '33:33',
      codeServerContainerPrefix: 'nvscode-code-server',
      codeServerDefaultExtensions: ['myriad-dreamin.tinymist', 'mathematic.vscode-pdf'],
      fileScanIntervalSeconds: 15,
    },
    waitForCodeServerReady: async () => {
      events.push('ready')
    },
  })

  await service.ensureCodeServer('alice', 'nvscode-code-server:latest')

  assert.deepEqual(events, ['stop', 'remove', 'create:2001:3001', 'start', 'ready'])
})

test('ensureCodeServer recreates containers that still use the legacy home-based state layout', async () => {
  const events = []
  const container = {
    inspect: async () => ({
      Config: {
        User: '2001:3001',
        Labels: {},
        Env: ['HOME=/home/coder'],
      },
      HostConfig: {
        Binds: [
          '/srv/nextcloud-data/alice/files:/workspace',
          '/srv/launcher-state/alice/config:/home/coder/.config',
          '/srv/launcher-state/alice/data:/home/coder/.local/share/code-server',
        ],
      },
      State: { Running: true },
    }),
    stop: async () => {
      events.push('stop')
    },
    remove: async () => {
      events.push('remove')
    },
  }
  const docker = {
    modem: {
      followProgress: (_stream, callback) => callback(),
    },
    getImage: () => ({
      inspect: async () => ({ Id: 'image-id' }),
    }),
    getContainer: () => container,
    createContainer: async (spec) => {
      if (spec.Cmd[0] === 'stat -c %u:%g /workspace-user-files') {
        return {
          start: async () => {},
          wait: async () => ({ StatusCode: 0 }),
          logs: async () => Buffer.from('2001:3001\n'),
          remove: async () => {},
        }
      }

      if (spec.User === '0:0') {
        return {
          start: async () => {},
          wait: async () => ({ StatusCode: 0 }),
        }
      }

      events.push(`create:${spec.User}`)
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
      nextcloudContainerName: '',
      nextcloudContainerLabel: 'com.docker.compose.service=nextcloud',
      nextcloudExecUser: 'www-data',
      nextcloudExecWorkingDir: '/var/www/html',
      nextcloudOccCommand: 'php occ',
      nextcloudDataHostPath: '/srv/nextcloud-data',
      launcherStateHostPath: '/srv/launcher-state',
      dockerNetworkName: 'nvscode_default',
      codeServerImage: 'nvscode-code-server:latest',
      codeServerRunAs: '33:33',
      codeServerContainerPrefix: 'nvscode-code-server',
      codeServerDefaultExtensions: ['myriad-dreamin.tinymist', 'mathematic.vscode-pdf'],
      fileScanIntervalSeconds: 15,
    },
    waitForCodeServerReady: async () => {
      events.push('ready')
    },
  })

  await service.ensureCodeServer('alice', 'nvscode-code-server:latest')

  assert.deepEqual(events, ['stop', 'remove', 'create:2001:3001', 'start', 'ready'])
})

test('stopAndRemoveContainer stops running containers before removing them', async () => {
  const events = []

  await stopAndRemoveContainer({
    stop: async () => {
      events.push('stop')
    },
    remove: async () => {
      events.push('remove')
    },
  }, { State: { Running: true } })

  assert.deepEqual(events, ['stop', 'remove'])
})
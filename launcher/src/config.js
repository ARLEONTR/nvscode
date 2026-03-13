function parseIntValue(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function parseCsvList(value, fallback = []) {
  const source = typeof value === 'string' && value.trim() !== ''
    ? value
    : fallback.join(',')

  return source
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry, index, values) => entry !== '' && values.indexOf(entry) === index)
}

function parseUidGid(value, fallback) {
  const source = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback

  if (!/^\d+:\d+$/.test(source)) {
    throw new Error('CODE_SERVER_RUN_AS must use the format <uid>:<gid>')
  }

  return source
}

function createConfig(env = process.env) {
  return {
    port: parseIntValue(env.PORT, 3000),
    internalSharedSecret: env.INTERNAL_SHARED_SECRET || '',
    sessionSigningSecret: env.SESSION_SIGNING_SECRET || '',
    nextcloudDataHostPath: (env.NEXTCLOUD_DATA_HOST_PATH || '').replace(/\/+$/, ''),
    launcherStateHostPath: (env.LAUNCHER_STATE_HOST_PATH || '').replace(/\/+$/, ''),
    nextcloudContainerName: (env.NEXTCLOUD_CONTAINER_NAME || '').trim(),
    nextcloudContainerLabel: (env.NEXTCLOUD_CONTAINER_LABEL || 'com.docker.compose.service=nextcloud').trim(),
    nextcloudExecUser: (env.NEXTCLOUD_EXEC_USER || 'www-data').trim() || 'www-data',
    nextcloudExecWorkingDir: (env.NEXTCLOUD_EXEC_WORKING_DIR || '/var/www/html').trim() || '/var/www/html',
    nextcloudOccCommand: (env.NEXTCLOUD_OCC_COMMAND || 'php occ').trim() || 'php occ',
    dockerNetworkName: env.DOCKER_NETWORK_NAME || 'nvscode_default',
    codeServerImage: env.CODE_SERVER_IMAGE || 'nvscode-code-server:latest',
    codeServerRunAs: parseUidGid(env.CODE_SERVER_RUN_AS, '33:33'),
    codeServerContainerPrefix: env.CODE_SERVER_CONTAINER_PREFIX || 'nvscode-code-server',
    codeServerDefaultExtensions: parseCsvList(env.CODE_SERVER_DEFAULT_EXTENSIONS, ['myriad-dreamin.tinymist', 'mathematic.vscode-pdf']),
    defaultSessionTtlSeconds: clamp(parseIntValue(env.DEFAULT_SESSION_TTL_SECONDS, 3600), 300, 86400),
    defaultIdleTimeoutSeconds: clamp(parseIntValue(env.DEFAULT_IDLE_TIMEOUT_SECONDS, 3600), 300, 86400),
    cleanupIntervalSeconds: clamp(parseIntValue(env.CLEANUP_INTERVAL_SECONDS, 300), 30, 86400),
    fileScanIntervalSeconds: clamp(parseIntValue(env.FILE_SCAN_INTERVAL_SECONDS, 15), 5, 3600),
  }
}

function validateConfig(config) {
  if (!config.internalSharedSecret) {
    throw new Error('INTERNAL_SHARED_SECRET must be configured')
  }

  if (!config.sessionSigningSecret) {
    throw new Error('SESSION_SIGNING_SECRET must be configured')
  }

  if (!config.nextcloudDataHostPath) {
    throw new Error('NEXTCLOUD_DATA_HOST_PATH must be configured')
  }

  if (!config.launcherStateHostPath) {
    throw new Error('LAUNCHER_STATE_HOST_PATH must be configured')
  }
}

module.exports = {
  clamp,
  createConfig,
  parseCsvList,
  parseIntValue,
  parseUidGid,
  validateConfig,
}

const Docker = require('dockerode')
const http = require('http')
const { createConfig, validateConfig } = require('./config')
const { SessionService } = require('./session-service')
const { createLauncherApp } = require('./app')

const config = createConfig(process.env)
validateConfig(config)

const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock' })
const sessionService = new SessionService({ docker, config })
sessionService.startCleanupLoop()

const { app, handleUpgrade } = createLauncherApp({
  internalSharedSecret: config.internalSharedSecret,
  sessionService,
})

const server = http.createServer(app)

server.on('upgrade', handleUpgrade)

server.listen(config.port, () => {
  process.stdout.write(`nvscode-launcher listening on ${config.port}\n`)
})


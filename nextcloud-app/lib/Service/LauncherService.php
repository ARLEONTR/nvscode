<?php

declare(strict_types=1);

namespace OCA\NVSCode\Service;

use OCP\Http\Client\IClientService;
use OCP\ILogger;
use RuntimeException;
use Throwable;

class LauncherService {
    public function __construct(
        private IClientService $clientService,
        private ILogger $logger,
        private AppConfigService $appConfig,
    ) {
    }

    /**
     * @return array{iframePath: string, expiresAt: string}
     */
    public function createSession(string $userId, string $workspacePath, ?string $filePath = null): array {
        $launcherUrl = rtrim($this->appConfig->getLauncherUrl(), '/');
        $sharedSecret = $this->appConfig->getSharedSecret();

        if ($sharedSecret === '') {
            throw new RuntimeException('NVSCODE_SHARED_SECRET is not configured.');
        }

        $payload = [
            'userId' => $userId,
            'workspacePath' => $workspacePath,
            'filePath' => $filePath,
            'sessionTtlSeconds' => $this->appConfig->getSessionTtlSeconds(),
            'idleTimeoutSeconds' => $this->appConfig->getIdleTimeoutSeconds(),
            'codeServerImage' => $this->appConfig->getCodeServerImage(),
        ];

        try {
            $response = $this->clientService->newClient()->post($launcherUrl . '/internal/sessions', [
                'headers' => [
                    'Accept' => 'application/json',
                    'Content-Type' => 'application/json',
                    'X-Shared-Secret' => $sharedSecret,
                ],
                'body' => json_encode($payload, JSON_THROW_ON_ERROR),
                'nextcloud' => [
                    'allow_local_address' => true,
                ],
                'timeout' => 120,
            ]);
        } catch (Throwable $exception) {
            $this->logger->error('Unable to contact VS Code launcher: ' . $exception->getMessage(), [
                'app' => 'nvscode',
                'exception' => $exception,
            ]);

            throw new RuntimeException('The VS Code launcher is unavailable.');
        }

        $rawBody = (string) $response->getBody();

        try {
            $data = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
        } catch (Throwable $exception) {
            $this->logger->error('Invalid launcher response: ' . $exception->getMessage(), [
                'app' => 'nvscode',
                'response' => $rawBody,
            ]);

            throw new RuntimeException('The VS Code launcher returned an invalid response.');
        }

        if (!is_array($data) || !isset($data['iframePath']) || !is_string($data['iframePath'])) {
            throw new RuntimeException('The VS Code launcher did not return an iframe path.');
        }

        return [
            'iframePath' => $data['iframePath'],
            'expiresAt' => isset($data['expiresAt']) && is_string($data['expiresAt']) ? $data['expiresAt'] : '',
        ];
    }
}


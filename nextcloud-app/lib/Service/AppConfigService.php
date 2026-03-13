<?php

declare(strict_types=1);

namespace OCA\NVSCode\Service;

use InvalidArgumentException;
use OCP\IConfig;

class AppConfigService {
    private const APP_ID = 'nvscode';
    private const LEGACY_APP_ID = 'vscode';
    private const KEY_LAUNCHER_URL = 'launcher_url';
    private const KEY_SHARED_SECRET = 'shared_secret';
    private const KEY_SESSION_TTL_SECONDS = 'session_ttl_seconds';
    private const KEY_IDLE_TIMEOUT_SECONDS = 'idle_timeout_seconds';
    private const KEY_CODE_SERVER_IMAGE = 'code_server_image';

    public function __construct(private IConfig $config) {
    }

    /**
     * @return array{launcherUrl: string, sharedSecret: string, sessionTtlSeconds: int, idleTimeoutSeconds: int, codeServerImage: string}
     */
    public function getSettings(): array {
        return [
            'launcherUrl' => $this->getLauncherUrl(),
            'sharedSecret' => $this->getSharedSecret(),
            'sessionTtlSeconds' => $this->getSessionTtlSeconds(),
            'idleTimeoutSeconds' => $this->getIdleTimeoutSeconds(),
            'codeServerImage' => $this->getCodeServerImage(),
        ];
    }

    public function getLauncherUrl(): string {
        return $this->getString(self::KEY_LAUNCHER_URL, $this->getEnvString(['NVSCODE_LAUNCHER_URL', 'VSCODE_LAUNCHER_URL'], 'http://nvscode-launcher:3000'));
    }

    public function getSharedSecret(): string {
        return $this->getString(self::KEY_SHARED_SECRET, $this->getEnvString(['NVSCODE_SHARED_SECRET', 'VSCODE_SHARED_SECRET'], ''));
    }

    public function getSessionTtlSeconds(): int {
        return $this->getInt(self::KEY_SESSION_TTL_SECONDS, $this->getEnvInt(['NVSCODE_SESSION_TTL_SECONDS', 'VSCODE_SESSION_TTL_SECONDS'], 3600), 300, 86400);
    }

    public function getIdleTimeoutSeconds(): int {
        return $this->getInt(self::KEY_IDLE_TIMEOUT_SECONDS, $this->getEnvInt(['NVSCODE_IDLE_TIMEOUT_SECONDS', 'VSCODE_IDLE_TIMEOUT_SECONDS'], 3600), 300, 86400);
    }

    public function getCodeServerImage(): string {
        return $this->getString(self::KEY_CODE_SERVER_IMAGE, (string) (getenv('CODE_SERVER_IMAGE') ?: 'nvscode-code-server:latest'));
    }

    /**
     * @param array{launcherUrl?: string, sharedSecret?: string, sessionTtlSeconds?: mixed, idleTimeoutSeconds?: mixed, codeServerImage?: string} $values
     */
    public function saveSettings(array $values): void {
        $this->config->setAppValue(self::APP_ID, self::KEY_LAUNCHER_URL, $this->sanitizeLauncherUrl((string) ($values['launcherUrl'] ?? $this->getLauncherUrl())));

        if (array_key_exists('sharedSecret', $values)) {
            $sharedSecret = $this->sanitizeSharedSecret((string) $values['sharedSecret']);
            if ($sharedSecret !== null) {
                $this->config->setAppValue(self::APP_ID, self::KEY_SHARED_SECRET, $sharedSecret);
            }
        }

        $this->config->setAppValue(self::APP_ID, self::KEY_SESSION_TTL_SECONDS, (string) $this->normalizeIntValue($values['sessionTtlSeconds'] ?? $this->getSessionTtlSeconds(), 300, 86400));
        $this->config->setAppValue(self::APP_ID, self::KEY_IDLE_TIMEOUT_SECONDS, (string) $this->normalizeIntValue($values['idleTimeoutSeconds'] ?? $this->getIdleTimeoutSeconds(), 300, 86400));
        $this->config->setAppValue(self::APP_ID, self::KEY_CODE_SERVER_IMAGE, $this->sanitizeCodeServerImage((string) ($values['codeServerImage'] ?? $this->getCodeServerImage())));
    }

    private function getString(string $key, string $default): string {
        $value = trim($this->config->getAppValue(self::APP_ID, $key, ''));
        if ($value !== '') {
            return $value;
        }

        $legacyValue = trim($this->config->getAppValue(self::LEGACY_APP_ID, $key, ''));
        if ($legacyValue !== '') {
            return $legacyValue;
        }

        return trim($default);
    }

    private function getInt(string $key, int $default, int $min, int $max): int {
        $currentValue = trim($this->config->getAppValue(self::APP_ID, $key, ''));
        if ($currentValue !== '') {
            return $this->normalizeIntValue($currentValue, $min, $max);
        }

        $legacyValue = trim($this->config->getAppValue(self::LEGACY_APP_ID, $key, ''));
        if ($legacyValue !== '') {
            return $this->normalizeIntValue($legacyValue, $min, $max);
        }

        return $this->normalizeIntValue($default, $min, $max);
    }

    private function normalizeIntValue(mixed $value, int $min, int $max): int {
        $normalized = (int) $value;
        if ($normalized < $min) {
            return $min;
        }

        if ($normalized > $max) {
            return $max;
        }

        return $normalized;
    }

    private function sanitizeLauncherUrl(string $value): string {
        $value = rtrim(trim($value), '/');
        if ($value === '') {
            return 'http://nvscode-launcher:3000';
        }

        if (filter_var($value, FILTER_VALIDATE_URL) === false) {
            throw new InvalidArgumentException('Launcher URL must be a valid absolute URL.');
        }

        $scheme = (string) parse_url($value, PHP_URL_SCHEME);
        if ($scheme !== 'http' && $scheme !== 'https') {
            throw new InvalidArgumentException('Launcher URL must use http or https.');
        }

        return $value;
    }

    private function sanitizeCodeServerImage(string $value): string {
        $value = trim($value);
        if ($value === '') {
            return 'nvscode-code-server:latest';
        }

        return $value;
    }

    private function sanitizeSharedSecret(string $value): ?string {
        $value = trim($value);
        if ($value === '') {
            return null;
        }

        if (filter_var($value, FILTER_VALIDATE_URL) !== false) {
            throw new InvalidArgumentException('Shared secret must be a secret value, not a URL.');
        }

        return $value;
    }

    private function getEnvString(array $keys, string $default): string {
        foreach ($keys as $key) {
            $value = getenv($key);
            if ($value !== false) {
                $value = trim((string) $value);
                if ($value !== '') {
                    return $value;
                }
            }
        }

        return $default;
    }

    private function getEnvInt(array $keys, int $default): int {
        foreach ($keys as $key) {
            $value = getenv($key);
            if ($value !== false && trim((string) $value) !== '') {
                return (int) $value;
            }
        }

        return $default;
    }
}

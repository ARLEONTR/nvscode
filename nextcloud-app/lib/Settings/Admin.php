<?php

declare(strict_types=1);

namespace OCA\NVSCode\Settings;

use OCA\NVSCode\AppInfo\Application;
use OCA\NVSCode\Service\AppConfigService;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\Settings\ISettings;

class Admin implements ISettings {
    public function __construct(private AppConfigService $appConfig) {
    }

    public function getForm(): TemplateResponse {
        return new TemplateResponse(Application::APP_ID, 'admin-settings', [
            'settings' => $this->appConfig->getSettings(),
            'standalone' => false,
        ], 'blank');
    }

    public function getSection(): string {
        return 'server';
    }

    public function getPriority(): int {
        return 50;
    }
}

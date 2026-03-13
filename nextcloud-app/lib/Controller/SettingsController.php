<?php

declare(strict_types=1);

namespace OCA\NVSCode\Controller;

use OCA\NVSCode\Service\AppConfigService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\DataResponse;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\IRequest;
use InvalidArgumentException;

class SettingsController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private AppConfigService $appConfig,
    ) {
        parent::__construct($appName, $request);
    }

    /**
     * @AdminRequired
     */
    #[NoCSRFRequired]
    public function page(): TemplateResponse {
        return new TemplateResponse($this->appName, 'admin-settings', [
            'settings' => $this->appConfig->getSettings(),
            'standalone' => true,
        ]);
    }

    /**
     * @AdminRequired
     */
    public function save(): DataResponse {
        try {
            $this->appConfig->saveSettings([
                'launcherUrl' => $this->request->getParam('launcherUrl'),
                'sharedSecret' => $this->request->getParam('sharedSecret'),
                'sessionTtlSeconds' => $this->request->getParam('sessionTtlSeconds'),
                'idleTimeoutSeconds' => $this->request->getParam('idleTimeoutSeconds'),
                'codeServerImage' => $this->request->getParam('codeServerImage'),
            ]);
        } catch (InvalidArgumentException $exception) {
            return new DataResponse([
                'status' => 'error',
                'message' => $exception->getMessage(),
            ], 400);
        }

        return new DataResponse([
            'status' => 'ok',
            'settings' => $this->appConfig->getSettings(),
        ]);
    }
}

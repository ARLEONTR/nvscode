<?php

declare(strict_types=1);

namespace OCA\NVSCode\Controller;

use OCA\NVSCode\Service\LauncherService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\TemplateResponse;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\IGroupManager;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\IUserSession;
use RuntimeException;

class EditorController extends Controller {
    public function __construct(
        string $appName,
        IRequest $request,
        private IUserSession $userSession,
        private IRootFolder $rootFolder,
        private LauncherService $launcherService,
        private IGroupManager $groupManager,
        private IURLGenerator $urlGenerator,
    ) {
        parent::__construct($appName, $request);
    }

    /**
     * @NoAdminRequired
     */
    #[NoCSRFRequired]
    public function open(): TemplateResponse {
        $user = $this->userSession->getUser();

        if ($user === null) {
            throw new RuntimeException('A logged-in user is required.');
        }

        $requestedPath = $this->normalizeRequestedPath((string) $this->request->getParam('path', '/'));
        $userFolder = $this->rootFolder->getUserFolder($user->getUID());
        [$workspacePath, $filePath] = $this->resolveWorkspace($userFolder, $requestedPath);

        try {
            $session = $this->launcherService->createSession($user->getUID(), $workspacePath, $filePath);
        } catch (RuntimeException $exception) {
            return new TemplateResponse($this->appName, 'editor', [
                'iframePath' => '',
                'expiresAt' => '',
                'requestedPath' => $requestedPath,
                'error' => $exception->getMessage(),
                'settingsPath' => $this->urlGenerator->linkToRoute('nvscode.settings.page'),
                'showSettingsLink' => $this->groupManager->isAdmin($user->getUID()),
            ]);
        }

        return new TemplateResponse($this->appName, 'editor', [
            'iframePath' => $session['iframePath'],
            'expiresAt' => $session['expiresAt'],
            'requestedPath' => $requestedPath,
            'error' => '',
            'settingsPath' => $this->urlGenerator->linkToRoute('nvscode.settings.page'),
            'showSettingsLink' => $this->groupManager->isAdmin($user->getUID()),
        ]);
    }

    /**
     * @return array{0: string, 1: ?string}
     */
    private function resolveWorkspace(Folder $userFolder, string $requestedPath): array {
        $relativePath = ltrim($requestedPath, '/');

        if ($relativePath === '') {
            return ['/', null];
        }

        if (!$userFolder->nodeExists($relativePath)) {
            throw new RuntimeException('The requested file or folder does not exist.');
        }

        $node = $userFolder->get($relativePath);

        if ($node instanceof Folder) {
            return [$requestedPath, null];
        }

        $directory = dirname($requestedPath);
        if ($directory === '.' || $directory === '') {
            $directory = '/';
        }

        return [$directory, $requestedPath];
    }

    private function normalizeRequestedPath(string $path): string {
        $path = trim($path);
        if ($path === '' || $path === '/') {
            return '/';
        }

        $segments = explode('/', str_replace('\\', '/', $path));
        $normalized = [];

        foreach ($segments as $segment) {
            if ($segment === '' || $segment === '.') {
                continue;
            }

            if ($segment === '..') {
                throw new RuntimeException('Invalid path.');
            }

            $normalized[] = $segment;
        }

        return '/' . implode('/', $normalized);
    }
}

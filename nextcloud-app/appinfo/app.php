<?php

declare(strict_types=1);

use OCA\NVSCode\AppInfo\Application;

$app = new Application();

$server = \OC::$server;
$urlGenerator = $server->getURLGenerator();

$server->getNavigationManager()->add(static function () use ($urlGenerator): array {
	return [
		'id' => Application::APP_ID,
		'order' => 70,
		'href' => $urlGenerator->linkToRoute('nvscode.editor.open', ['path' => '/']),
		'icon' => $urlGenerator->imagePath(Application::APP_ID, 'icon.svg'),
		'name' => 'nVSCode',
	];
});

\OCP\Util::addScript(Application::APP_ID, 'files-action');

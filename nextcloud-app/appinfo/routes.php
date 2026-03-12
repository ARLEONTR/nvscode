<?php

declare(strict_types=1);

return [
    'routes' => [
        ['name' => 'editor#open', 'url' => '/editor', 'verb' => 'GET'],
        ['name' => 'settings#page', 'url' => '/admin-settings', 'verb' => 'GET'],
        ['name' => 'settings#save', 'url' => '/settings', 'verb' => 'POST'],
    ],
];

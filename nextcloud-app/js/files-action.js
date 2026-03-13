(function () {
    const TYPST_MIME_TYPES = [
        'text/x-typst',
        'application/x-typst',
        'application/typst',
    ];

    const actionDefinition = {
        name: 'openInNVSCode',
        displayName: t('nvscode', 'Open in nVSCode'),
        mime: 'all',
        permissions: OC.PERMISSION_READ,
        actionHandler(fileName, context) {
            openEditor(buildPath(context, fileName));
        },
    };

    const buildPath = (context, fileName) => {
        const dir = context && typeof context.dir === 'string' ? context.dir : '/';
        const prefix = dir === '/' ? '' : dir;

        return `${prefix}/${fileName}`.replace(/\/+/g, '/');
    };

    const openEditor = (targetPath) => {
        const url = `${OC.generateUrl('/apps/nvscode/editor')}?path=${encodeURIComponent(targetPath)}`;
        window.location.assign(url);
    };

    const registerTypstDefaults = (fileActions) => {
        if (!fileActions || typeof fileActions.setDefault !== 'function') {
            return;
        }

        TYPST_MIME_TYPES.forEach((mime) => {
            fileActions.setDefault(mime, actionDefinition.name);
        });
    };

    const registerGlobalAction = () => {
        if (!window.OCA || !OCA.Files || !OCA.Files.fileActions || registerGlobalAction.done) {
            return;
        }

        registerGlobalAction.done = true;

        OCA.Files.fileActions.registerAction(actionDefinition);
        registerTypstDefaults(OCA.Files.fileActions);
    };

    const registerFileListPlugin = () => {
        if (!window.OC || !OC.Plugins || registerFileListPlugin.done) {
            return false;
        }

        registerFileListPlugin.done = true;

        OC.Plugins.register('OCA.Files.FileList', {
            attach(fileList) {
                fileList.fileActions.registerAction(actionDefinition);
                registerTypstDefaults(fileList.fileActions);
            },
        });

        return true;
    };

    document.addEventListener('DOMContentLoaded', () => {
        if (!registerFileListPlugin()) {
            registerGlobalAction();
        }
    });
})();

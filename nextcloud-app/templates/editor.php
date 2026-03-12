<div id="nvscode-root">
  <div id="nvscode-toolbar">
    <div id="nvscode-toolbar-meta">
      <span>nVSCode</span>
      <span><?php p($_['requestedPath']); ?></span>
      <?php if ($_['expiresAt'] !== '') { ?>
        <span>Valid until <?php p($_['expiresAt']); ?></span>
      <?php } ?>
    </div>
    <div id="nvscode-toolbar-actions">
      <?php if (!empty($_['showSettingsLink'])) { ?>
        <a id="nvscode-settings-link" href="<?php p($_['settingsPath']); ?>">Settings</a>
      <?php } ?>
      <a id="nvscode-back-link" href="/apps/files/">Files</a>
    </div>
  </div>
  <?php if ($_['error'] !== '') { ?>
    <div id="nvscode-error"><?php p($_['error']); ?></div>
  <?php } else { ?>
    <iframe id="nvscode-frame" src="<?php p($_['iframePath']); ?>" title="nVSCode"></iframe>
  <?php } ?>
</div>

<style>
  html,
  body,
  #body-user,
  #content,
  #app-content,
  #app-content-wrapper {
    height: 100%;
  }

  body,
  #app-content {
    overflow: hidden;
  }

  #nvscode-root {
    display: flex;
    flex-direction: column;
    position: fixed;
    top: var(--header-height, 50px);
    right: 0;
    bottom: 0;
    left: 0;
    z-index: 2000;
    height: calc(100dvh - var(--header-height, 50px));
    background: #111827;
    box-sizing: border-box;
  }

  #nvscode-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    min-height: 44px;
    padding: 10px 14px;
    background: rgba(17, 24, 39, 0.96);
    color: rgba(255, 255, 255, 0.88);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    box-sizing: border-box;
  }

  #nvscode-toolbar-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    font-size: 12px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  #nvscode-toolbar-meta span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  #nvscode-toolbar-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  #nvscode-back-link,
  #nvscode-settings-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
    text-decoration: none;
    font-size: 12px;
    font-weight: 600;
  }

  #nvscode-frame {
    flex: 1;
    width: 100%;
    min-height: 0;
    border: 0;
    background: #1f2937;
  }

  #nvscode-error {
    margin: 16px;
    padding: 16px;
    border: 1px solid rgba(248, 113, 113, 0.5);
    border-radius: 12px;
    background: rgba(127, 29, 29, 0.45);
    color: #fff;
  }

  @media (max-width: 768px) {
    #nvscode-root {
      top: var(--header-height, 50px);
      height: calc(100dvh - var(--header-height, 50px));
    }

    #nvscode-toolbar {
      flex-direction: column;
      align-items: flex-start;
      padding: 10px 12px;
    }

    #nvscode-toolbar-meta {
      width: 100%;
      flex-wrap: wrap;
    }
  }
</style>

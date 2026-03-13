<?php
/** @var array{launcherUrl: string, sharedSecret: string, sessionTtlSeconds: int, idleTimeoutSeconds: int, codeServerImage: string} $_['settings'] */
$standalone = isset($_['standalone']) && $_['standalone'] === true;
$sharedSecretConfigured = $_['settings']['sharedSecret'] !== '';
?>
<div class="section<?php if ($standalone) { ?> standalone<?php } ?>" id="nvscode-admin-settings">
  <h2>nVSCode</h2>
  <p>Manage how Nextcloud connects to the launcher and what session policy it requests for code-server workspaces.</p>

  <form id="nvscode-settings-form">
    <p>
      <label for="nvscode-launcher-url">Launcher URL</label><br>
      <input type="url" id="nvscode-launcher-url" name="launcherUrl" value="<?php p($_['settings']['launcherUrl']); ?>" class="settings-input">
    </p>

    <p>
      <label for="nvscode-shared-secret">Shared secret</label><br>
      <input type="password" id="nvscode-shared-secret" name="sharedSecret" value="" class="settings-input" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false">
      <span class="settings-hint">This must match the launcher bootstrap secret until dynamic secret rotation is added. Leave this empty to keep the existing secret.</span>
      <?php if ($sharedSecretConfigured) { ?>
        <span class="settings-hint">A shared secret is currently configured.</span>
      <?php } ?>
    </p>

    <p>
      <label for="nvscode-session-ttl">Session TTL in seconds</label><br>
      <input type="number" min="300" max="86400" id="nvscode-session-ttl" name="sessionTtlSeconds" value="<?php p((string) $_['settings']['sessionTtlSeconds']); ?>" class="settings-input">
    </p>

    <p>
      <label for="nvscode-idle-timeout">Idle timeout in seconds</label><br>
      <input type="number" min="300" max="86400" id="nvscode-idle-timeout" name="idleTimeoutSeconds" value="<?php p((string) $_['settings']['idleTimeoutSeconds']); ?>" class="settings-input">
    </p>

    <p>
      <label for="nvscode-image">Preferred code-server image</label><br>
      <input type="text" id="nvscode-image" name="codeServerImage" value="<?php p($_['settings']['codeServerImage']); ?>" class="settings-input">
    </p>

    <p>
      <button type="submit" class="primary">Save</button>
      <span id="nvscode-settings-status" class="settings-hint"></span>
    </p>
  </form>
</div>

<style>
  #nvscode-admin-settings.standalone {
    max-width: 760px;
    margin: 24px auto;
    padding: 0 16px 32px;
  }

  #nvscode-admin-settings .settings-input {
    width: min(560px, 100%);
  }

  #nvscode-admin-settings .settings-hint {
    display: block;
    margin-top: 6px;
    color: var(--color-text-maxcontrast);
  }
</style>

<script>
  (function () {
    const form = document.getElementById('nvscode-settings-form');
    const status = document.getElementById('nvscode-settings-status');

    if (!form || !status) {
      return;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      status.textContent = 'Saving...';

      const payload = new FormData(form);

      try {
        const response = await fetch(OC.generateUrl('/apps/nvscode/settings'), {
          method: 'POST',
          headers: {
            requesttoken: OC.requestToken,
          },
          body: payload,
        });

        if (!response.ok) {
          let message = 'Unable to save settings';

          try {
            const data = await response.json();
            if (data && typeof data.message === 'string' && data.message !== '') {
              message = data.message;
            }
          } catch (_error) {
          }

          throw new Error(message);
        }

        status.textContent = 'Saved';
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'Save failed';
      }
    });
  })();
</script>

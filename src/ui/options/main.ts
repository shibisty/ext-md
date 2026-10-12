import { loadCatalog, localizeDom, t } from '../../shared/i18n';
import { loadSettings } from '../../shared/settings';
import { initSettingsForm } from '../settings-form';
import { applyTheme } from '../theme';

async function init(): Promise<void> {
  const settings = await loadSettings();
  await loadCatalog(settings.mg_lang);
  localizeDom();
  document.title = t('settingsTitle');
  applyTheme(settings.mg_theme);
  const form = initSettingsForm(document, settings, {
    onLanguageChanged: () => {
      document.title = t('settingsTitle');
    },
  });
  await form.fill(settings);
}

void init();

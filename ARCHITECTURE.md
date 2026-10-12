# Media Grabber — архитектура

Версия 1.3.0: перенос с однофайлового JS на TypeScript + Vite, сборки для
Chrome и Firefox, тесты. Поведение для пользователя сохранено, кроме
исправленных ошибок (список ниже).

## Структура

```
src/
  manifest.ts            manifest.json для chrome/firefox (единственный источник)
  shared/                код без привязки к контексту — общий для всех частей
    types.ts             FoundImage/FoundVideo/ScanData/Settings…
    messages.ts          типизированный протокол сообщений + createRouter()
    media.ts             classify, extractCssUrls, guessFormat, extFromMime
    filenames.ts         safeName, baseNameFor — одна реализация для всех режимов
    zip.ts               ZIP-writer (store, без ZIP64, с проверками лимитов)
    base64.ts            base64 ⇄ bytes (нативный toBase64/fromBase64, если есть)
    settings.ts          настройки и состояние вида (сортировка/фильтры)
    selection-cache.ts   память выбора по URL страницы (LRU, 300 страниц)
    i18n.ts              явный выбор языка поверх chrome.i18n
    env.ts               __TARGET__ (chrome|firefox), sidebarAction
  background/            service worker (Chrome) / event page (Firefox)
    index.ts             подписки на события — только синхронно на верхнем уровне
    scan.ts              ping→inject контент-скрипта, сторонние CSS, слияние
    download.ts          режимы «Загрузки» и «.zip», blob-потоки
    hotkey.ts            Ctrl+Shift+M
  content/               внедряется по требованию (scripting.executeScript)
    index.ts             роутер сообщений
    collect.ts           <img>, CSS-фоны, <video>/<source>, правила CSS, сеть
    network.ts           NetworkTracker (PerformanceObserver, SPA-маршруты)
    blob-stream.ts       blob: → куски по 3 МБ; нативный <a download>
    highlight.ts         красная рамка на странице
  ui/
    popup.html, sidepanel.html, options.html
    popup/main.ts        оркестратор попапа и боковой панели
    popup/state.ts       чистая логика таблицы (фильтры, сортировка, статусы)
    popup/table.ts       рендер строк, клик/Shift+клик/протяжка
    popup/lightbox.ts, popup/context-menu.ts
    popup/directory-download.ts   режим «Папка по выбору»
    settings-form.ts     форма настроек — общая для options и попапа
    fs-handle.ts         File System Access API + IndexedDB
    theme.ts
public/                  _locales, icons — копируются как есть
tests/unit/              Vitest + jsdom, фейковый chrome.* (tests/unit/setup.ts)
tests/e2e/               Playwright: настоящий Chromium с dist/chrome
scripts/pack.mjs         zip для CWS, AMO и архив исходников для AMO
```

## Сборка

`vite build --mode chrome|firefox` → `dist/<target>/`.

- HTML-страницы собираются обычным образом (ES-модули, общий чанк `settings-form.js`).
- `background.js` и `content.js` собираются отдельными IIFE-бандлами в
  `closeBundle` плагина: контент-скрипт, внедряемый через
  `executeScript({ files })`, не может быть модулем, а фоновый скрипт
  Firefox надёжнее как классический. В обоих нет ни одного `import`.
- `manifest.json` генерируется из `src/manifest.ts` с версией из `package.json`.
- Минификации нет, имена файлов без хэшей: ревьюерам AMO проще сравнивать
  версии, а кэш внутри расширения не нужен.

Различия целей:

| | Chrome | Firefox |
|---|---|---|
| фон | `service_worker` | `background.scripts` (event page) |
| боковая панель | `side_panel` + `chrome.sidePanel.open` | `sidebar_action` + `browser.sidebarAction.open` |
| «Папка по выбору» | есть | нет API — пункт отключён |
| zip/data:-загрузки | `data:` URL (в SW нет `createObjectURL`) | `blob:` URL, отзывается по завершении загрузки |
| права на сайты | выдаются при установке | опциональны: попап показывает плашку «Разрешить» |

## Поток данных

```
popup ──MG_SCAN_TAB──▶ background ──MG_PING / executeScript──▶ content
                                   ──MG_SCAN─────────────────▶ collectMedia()
                                   ◀── externalSheets ── fetch() сторонних CSS
popup ◀── ScanData ─────────────── background
popup ──MG_DOWNLOAD_ITEMS──▶ background ── downloads.download / zip
                                         ── MG_STREAM_OPEN/NEXT (blob:) ──▶ content
popup (папка по выбору) ── MG_STREAM_* напрямую в content, запись через FS Access API
```

Все сообщения описаны в `shared/messages.ts`: для каждого типа есть тип
запроса и тип ответа, поэтому отправитель и обработчик не могут
разойтись незаметно. `createRouter()` превращает брошенное исключение в
`{ ok: false, error }` и не трогает чужие типы сообщений.

## Исправленные ошибки

Пункты 1, 3, 4, 5, 6 воспроизведены на старом коде в том же e2e-стенде, остальные найдены по коду.

1. **Кнопка «Скачать выбранное» не работала.** `addEventListener('click', handleDownload)`
   передавал объект события вместо списка → «Error: selectedItems.map is not a function».
   Скачивание работало только через контекстное меню и горячую клавишу.
2. **Firefox-сборки фактически не было.** `background.service_worker` и
   `importScripts` в Firefox MV3 не работают; ключ `sidePanel` неизвестен.
3. **После обновления/перезагрузки расширения скан падал** на уже открытых
   вкладках («Receiving end does not exist») до перезагрузки страницы:
   флаг установки старого скрипта оставался, а повторное внедрение на нём
   останавливалось. Теперь — ping, при неудаче сброс флага и внедрение;
   множество `INJECTED_TABS` (терялось при каждом перезапуске SW) удалено.
4. **Протяжка мышью «залипала».** Таблица перерисовывалась целиком на каждой
   строке во время протяжки, узел под курсором удалялся, и `mouseup` терялся
   (в стенде — 0 событий и в старом коде). После этого любое наведение
   продолжало менять выбор. Теперь строки обновляются на месте, протяжка
   завершается и по `e.buttons === 0`.
5. **`performance.clearResourceTimings()` на чужой странице.** Скан обнулял
   буфер Resource Timing страницы (у страницы оставалось 0 записей) — это
   ломает её аналитику/RUM, а повторный скан не видел медиа, найденное только
   по сети. Теперь `NetworkTracker`: PerformanceObserver, отсечка по началу
   SPA-навигации, переходы по `#якорю` маршрутом не считаются. 404-записи
   (например `favicon.ico`) отбрасываются.
6. **`url(...)` в CSS-комментариях попадал в список** (в стенде — `commented.png`).
7. **Правила внутри `@media`/`@supports`/`@import` не просматривались.**
8. **В .zip попадали страницы ошибок.** Ответ 404/403 сохранялся как `photo.jpg`.
   Теперь `http-<код>` и файл в отчёте как неудачный.
9. **«Папка по выбору» перезаписывала файлы** с тем же именем (из прошлых загрузок
   или два разных `image.jpg`) — теперь `имя (2).jpg`; blob-видео больше не
   называются `video_1.stream`; при ошибке не остаётся пустой файл.
10. **Обрезанные файлы.** Неизвестный id blob-потока считался «готово» —
    теперь это ошибка `stream-expired`. Брошенные потоки закрываются через 60 с.
11. Кнопка темы 🌙/☀ была в CSS и README, но пропала из разметки — возвращена.
    Тема «системная» теперь следует за ОС на лету.
12. Shift+клик (диапазон) был заявлен в README, но не реализован — сделан.
13. Ключи `mg_sel::<url>` копились в `storage.local` бесконечно (квота 10 МБ) —
    теперь LRU на 300 страниц.
14. «Авто»-язык при неподдерживаемом языке браузера: попап показывал русский
    (default_locale), страница настроек — английский. Теперь везде английский.
15. Боковая панель не обновлялась при переключении вкладок — теперь
    пересканирует (и не даёт скачать список предыдущей страницы во время скана).
16. Имена файлов: зарезервированные в Windows (`CON.jpg`), точки/пробелы
    в конце, длина > 150 символов.

## Тесты

- `npm test` — 95 unit-тестов: zip (с разбором архива), base64, имена файлов,
  CSS-парсинг, i18n (одинаковые ключи и плейсхолдеры во всех локалях, все
  `data-i18n` и `t('…')` существуют), хранилище и LRU, логика таблицы,
  сканер в jsdom, NetworkTracker, перебатчинг blob-потока, background
  с фейковым `chrome.*` (режимы загрузки, ошибки, Firefox-путь с blob URL),
  манифесты обеих целей.
- `npm run test:e2e` — 9 сценариев в настоящем Chromium с загруженным
  `dist/chrome` и тестовым сайтом на двух origin'ах: все источники медиа и
  дедупликация, рескан, подсветка, клик/Shift/протяжка/фильтры/память выбора,
  режимы «Загрузки» и «.zip» (архив разбирается, blob-байты на месте),
  боковая панель и настройки, тема, сценарий «осиротевшего» контент-скрипта.
- Firefox-сборка: `web-ext lint` — 0 ошибок; 1 информационное предупреждение
  про `permissions.request` на Firefox для Android (Android не заявлен).
  В живом Firefox не запускалась — в окружении не было Firefox.

## Предложения по развитию

По убыванию пользы:

1. **Offscreen document для .zip в Chrome.** Сейчас архив собирается целиком в
   памяти SW и уходит как `data:` URL (base64, +33%). Для архивов в сотни МБ
   надёжнее собирать zip в offscreen-документе (`chrome.offscreen`,
   причина `BLOBS`) и скачивать `blob:` URL — или потоково писать zip
   прямо в «Папку по выбору».
2. **HLS/DASH.** MSE-видео (`blob:` без байтов) сейчас честно помечается как
   «поток». Следующий шаг — перехватывать `.m3u8`/`.mpd` из сети
   (NetworkTracker уже видит запросы), разбирать плейлист и склеивать сегменты.
   Это крупная фича; DRM-контент по-прежнему не трогаем.
3. **`srcset` / `<picture>`.** Берётся только `currentSrc` — то, что браузер
   выбрал под текущий экран. Можно показывать максимальный вариант из `srcset`.
4. **Shadow DOM и iframe.** `querySelectorAll` не заходит в открытые shadow
   roots и в iframe (для iframe нужен `allFrames: true` + сбор по кадрам).
5. **Прогресс скачивания.** Для zip/папки — счётчик байтов через
   `runtime.Port` вместо одного ответа в конце; отмена.
6. **Права по требованию.** `<all_urls>` в `host_permissions` пугает при
   установке и замедляет ревью. Можно перенести в `optional_host_permissions`
   и запрашивать при первом скане стороннего CSS/zip, а базовая функция
   будет работать на `activeTab`.
7. **ID расширения для AMO.** `media-grabber@example.local` — заглушка; перед
   публикацией заменить на свой домен/UUID (сменить потом нельзя).
8. **default_locale.** Сейчас `ru`: в магазинах для неподдерживаемых языков
   название и описание будут русскими. Если аудитория шире — `en`.

## Совместимость

- Chrome/Edge 116+ (side panel).
- Firefox 115+ (storage.session, MV3). На Firefox < 127 права на сайты
  нужно выдать вручную — попап показывает плашку с кнопкой.
- Node.js 20.19+ / 22.12+ для сборки. Vitest закреплён на `~4.0.18`:
  4.1.x ломает `npm install` в npm 10 (ошибка arborist `edgesOut`).

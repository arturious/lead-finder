# Lead Finder

Небольшое приложение для macOS (Apple Silicon): ищет публичные профили трейдеров на Myfxbook по стране и складывает их в таблицу. В аккаунт не входит и никому не пишет.

Поиск идёт в фоне через [CloakBrowser](https://github.com/cloakhq/cloakbrowser) (`launchPersistentContext`). Запросы к сайту делаются через `fetch` внутри открытой страницы myfxbook.com, поэтому уходят вместе с cookies и отпечатком браузера. Профиль браузера лежит в userData и переживает перезапуск. Пока Cloudflare не мешает, окно браузера скрыто. Если появляется страница «Just a moment», поиск ставится на паузу, окно показывается, и после проверки продолжается само.

Один запрос за раз, пауза 2–3 секунды. На 403, 429 и таймаут — пауза от 1 минуты с удвоением, не дольше 30 минут. Уже проверенные ники и найденные лиды пишутся в userData (`lead-finder.json`), повторный запуск их не обходит заново.

Сайт в списке сейчас один — Myfxbook. Новый сайт добавляется отдельным модулем в `src/sources/` и строкой в `src/sources/index.js`.

## Запуск

Нужны Node.js 22 и macOS на Apple Silicon (для разработки сойдёт и Linux: подтянется бинарник CloakBrowser под текущую систему).

```bash
npm install
npm test
npm start
```

При первом поиске CloakBrowser скачивает Chromium (~200 МБ). Прогресс виден в строке статуса. Нужен бесплатный ключ: `npx cloakbrowser login`, затем вставьте его в поле в окне или задайте `CLOAKBROWSER_LICENSE_KEY`. Ключ сохраняется в `~/.cloakbrowser/license.key`.

На macOS данные приложения: `~/Library/Application Support/Lead Finder/`.

## Сборка

Неподписанный zip с `Lead Finder.app` для arm64:

```bash
npm run build
```

Архив появляется в `dist/Lead-Finder-arm64-mac.zip`. Подпись не ставится (`identity: null`).

Установка последней сборки из GitHub Releases в `/Applications` и снятие карантина:

```bash
curl -fsSL https://raw.githubusercontent.com/arturious/lead-finder/main/install.sh | bash
```

Первый запуск непроверенного приложения macOS может попросить открыть его через правый клик → «Открыть».

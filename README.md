# Lead Finder

Небольшое приложение для macOS (Apple Silicon): ищет публичные профили трейдеров на Myfxbook по стране и складывает их в таблицу. В аккаунт не входит и никому не пишет.

Поиск идёт в фоне через [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs) (`launchPersistentContext`, канал `chrome`). Запросы к сайту делаются через `fetch` внутри открытой страницы myfxbook.com, поэтому уходят вместе с cookies и отпечатком браузера. Свой user-agent и свой viewport не задаются. Профиль Chrome лежит в userData и переживает перезапуск. Окно свёрнуто. Если появляется «Just a moment» или Turnstile, поиск встаёт на паузу, окно разворачивается, и после проверки снова сворачивается.

Один запрос за раз, пауза 2–3 секунды. На 403, 429 и таймаут — пауза от 1 минуты с удвоением, не дольше 30 минут. Уже проверенные ники и найденные лиды пишутся в userData (`lead-finder.json`), повторный запуск их не обходит заново.

Сайт в списке сейчас один — Myfxbook. Новый сайт добавляется отдельным модулем в `src/sources/` и строкой в `src/sources/index.js`.

## Запуск

Нужны Node.js 22 и macOS на Apple Silicon. Для разработки сойдёт и Linux.

```bash
npm install
npm test
npm start
```

Первый запуск: откройте приложение, выберите страну, нажмите «Начать поиск». Ключ и регистрация не нужны. Если Google Chrome установлен, используется он. Если нет — первый поиск сам скачивает Chromium Patchright, прогресс виден в строке статуса.

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

# bkloop

Скилл Claude Code: бэкенд-цель от промпта до коммитов без надзора — карта кода, спайки неизвестного на живой системе, трассирующие юниты red → green в отдельных worktree, отладка, ревью, коммит по юниту, оценка и доработка до сходимости.

## Состав

| Путь | Что |
| --- | --- |
| `claude/skills/bkloop/SKILL.md` | оркестратор `/bkloop [N] [jK] <goal>` |
| `claude/skills/bkloop/spike-lease.mjs` | аренда аккаунтов из `.spike/sessions/` и зеркало `.spike/` в worktree — [опционально](#spike-lease-опционально) |
| `claude/skills/bkloop/spend.mjs` | расход токенов по сабагентам сессии, для отчёта |
| `claude/skills/spike/SKILL.md` | `/spike <question>` — исследование неизвестного |
| `claude/agents/` | `bkloop-implement`, `bkloop-debug`, `bkloop-critic`, `bkloop-run` (sonnet: команды и проверки по списку), `spike-researcher` |
| `claude/hooks/spike-guard.mjs` | блок ручных ссылок, копий сессий и удаления аренды |

## Требования

- git, Node 20+, `gh` не нужен.
- Плагин `mattpocock-skills` (маркетплейс `claude-plugins-official`): агенты грузят `tdd`, `diagnosing-bugs`, `codebase-design`.
  ```
  /plugin install mattpocock-skills@claude-plugins-official
  ```
- Необязательно: скилл `ai-socket` в `~/.claude/skills/` — вопросы разработчику через Telegram из спайка. Без него шаг уходит в OPEN.
- Windows: `spike-lease` делает junction (`mklink /J`) и hardlink — прав администратора не нужно.

## Установка в проект

```
git clone https://github.com/kakaponick/bkloop
node bkloop/install.mjs <путь к репо проекта>
```

Установщик копирует `claude/` в `<repo>/.claude/`, добавляет хук `spike-guard` в `.claude/settings.json`, `.spike/` в `.gitignore`, создаёт `.spike/{data,sessions,toolkits}` и шаблон `README.md`. Повторный запуск обновляет файлы, хук не дублирует.

## Проект

bkloop читает правила из `CLAUDE.md` проекта: команды установки, типов, тестов, миграций, запуск воркера, основная ветка, строгие правила. Чего там нет — решение, записанное в отчёт. Живые ресурсы (аккаунты, прокси, образцы) — в `.spike/`, описаны в `.spike/README.md`; раздел «Limits» — единственные ограничения.

## Spike lease (опционально)

Нужен, только когда агенты работают с живыми аккаунтами — сессиями, которые нельзя поднимать из двух процессов сразу (Telegram, кабинеты с привязкой к IP). Нет аккаунтов — `.spike/sessions/` пуст, `link` даёт пустое зеркало, `acquire` не вызывается; ничего настраивать не надо.

Как работает:

- Аккаунт — папка `.spike/sessions/<name>/` в основной рабочей копии.
- Каждый worktree прогона получает зеркало `.spike/` ссылками — всё, кроме `sessions/`.
- `acquire` берёт атомарную аренду (`.lease` в папке сессии) и только тогда ссылает папку в worktree. Без аренды папки в worktree нет: скрипт или тест падает на отсутствующем пути, а не делит сессию с другим процессом.
- `spike-guard` блокирует обход: ручные ссылки в `.spike`, копирование из `sessions/`, удаление `.lease`.

```
node .claude/skills/bkloop/spike-lease.mjs link <checkout>
node .claude/skills/bkloop/spike-lease.mjs acquire <checkout> <session> [--wait s]
node .claude/skills/bkloop/spike-lease.mjs release <checkout> <session>
node .claude/skills/bkloop/spike-lease.mjs unlink <checkout>
node .claude/skills/bkloop/spike-lease.mjs status
```

Пробы в worktree не кладите под `.spike/`: это ссылка в основную копию, файл окажется там, а `@/`-импорты разрешатся от её `tsconfig`, не от worktree.

## Запуск

```
/bkloop <goal>              3 прохода, 3 полосы
/bkloop 5 j1 <goal>         5 проходов, последовательно
/bkloop resume <run id>
/spike <question>
```

Состояние прогона — `.claude/bkloop/<run id>/` (журнал, брифы, отчёт), исключён через `.git/info/exclude`.

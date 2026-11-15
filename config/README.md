# Runtime configuration

`config.json` is served next to the app and read at start. Builds pick it like this:

| Build | Config used |
| --- | --- |
| Desktop app (`npm run build`, releases) | `config/default.json`: no server or agents preset; people enter their own. |
| Web app (`npm run build:web`) and dev server | `local/config.json` if it exists, otherwise `config/default.json`. |

`local/` is git-ignored: put your own deployment there. Example:

```json
{
  "default_homeserver": "https://matrix.example.org",
  "homeserver_moves": { "https://old.example.org": "https://matrix.example.org" },
  "agents": [
    {
      "user_id": "@hermes:example.org",
      "name": "Hermes",
      "kind": "hermes",
      "role": "coordinator",
      "extraModels": [{ "model": "my-model", "provider": "lmstudio", "providerLabel": "LM Studio" }]
    }
  ]
}
```

Agents listed here are also copied into your Matrix account data when you sign in, so every Orrery
you use (including the desktop app from GitHub releases) knows them. Agents added in
**Agents → Add agent** are stored the same way.

# CC GUI (Claude and Codex)

[中文](./README.zh-CN.md)

A 100% open-source GUI for Claude Code CLI and Codex, shipped as a VS Code extension.  

> **Unofficial.** CC GUI is an independent open-source project and is **not affiliated with, endorsed by, or sponsored by** Anthropic, OpenAI, or Microsoft.

---

## Build and Package the VSIX

From the project root:

```bash
npm install
cd webview && npm install && cd ..
cd ai-bridge && npm install && cd ..
npm run build
npm exec --yes --package=@vscode/vsce -- vsce package
```

The generated file is named `vscode-cc-gui-<version>.vsix` in the project root. Install it in VS Code with:

```bash
code --install-extension ./vscode-cc-gui-0.1.0.vsix
```

### Repair a broken global `vsce` command

If a global `vsce` install is broken, reinstall it:

```bash
npm uninstall -g @vscode/vsce
npm install -g @vscode/vsce
vsce package
```

---

## License

[MIT](./LICENSE)

---

## Contributors

Thanks to everyone who has helped make CC GUI better.

<a href="https://github.com/hpstream/vscode-cc-gui/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=hpstream/vscode-cc-gui" alt="Contributors" />
</a>

---

## Acknowledgements

1. This project was originally adapted from [jetbrains-cc-gui](https://github.com/zhukunpenglinyutong/jetbrains-cc-gui), with permission from the original author.
2. The Design · Usage Statistics module is largely based on the [TokenTracker](https://github.com/mm7894215/TokenTracker) source code.

---

## Trademarks

- **Claude** and **Claude Code** are trademarks of Anthropic, PBC.
- **Codex**, **ChatGPT**, and **OpenAI** are trademarks of OpenAI.
- **Visual Studio Code** and **VS Code** are trademarks of Microsoft Corporation.

These names are used solely to describe third-party products and technologies that this extension is compatible with or integrates. They do **not** imply any affiliation, endorsement, or sponsorship by the respective rights holders.

Claude®, Claude Code, Codex, ChatGPT, OpenAI, Visual Studio Code, and related marks are trademarks of their respective owners. They are used here only to describe interoperability. This project is not affiliated with or endorsed by those trademark owners.

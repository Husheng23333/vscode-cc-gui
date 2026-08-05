# CC GUI (Claude and Codex)

[中文](./README.zh-CN.md)

A 100% open-source GUI for Claude Code CLI and Codex, shipped as a VS Code extension.  

> **Unofficial.** CC GUI is an independent open-source project and is **not affiliated with, endorsed by, or sponsored by** Anthropic, OpenAI, or Microsoft.

---

## Windows PowerShell: Build and Package the VSIX

Run the following commands from the project root. This builds the extension and webview, then packages them into a `.vsix` file without relying on a globally installed `vsce` command:

```powershell
cd D:\livehime\code\vscode-cc-gui
npm install
npm run build
npm exec --yes --package=@vscode/vsce -- vsce package
```

The generated file is named `vscode-cc-gui-<version>.vsix` and is placed in the project root. Install it in VS Code with:

```powershell
code --install-extension .\vscode-cc-gui-0.0.2.vsix
```

If the webview dependencies are missing, install them once and run the build again:

```powershell
cd D:\livehime\code\vscode-cc-gui\webview
npm install
cd ..
npm run build
npm exec --yes --package=@vscode/vsce -- vsce package
```

### Repair the Global `vsce` Command

If `vsce.cmd` reports `Cannot find module ...@vscode\\vsce\\vsce`, reinstall the global package:

```powershell
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

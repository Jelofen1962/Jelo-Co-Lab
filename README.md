# Full Working, Fine-Tuned Code Collaboration Extension  
*By @Jelofen1962*

## Setup Instructions

### Starting the Server  
On the server directory, run:

```bash
cd server
npm install && npm run
```

### Installing the VS Code Extension  
You can either:

- Install the provided `.vsix` extension package directly in VS Code, **or**  
- Build your own extension package by running:

```bash
cd vscode-extension
npm install && npm run compile && vsce package
```

This will produce a `.vsix` file that you can then install in VS Code.

---

### Ready to Use!  
Start the server, install or build the VSIX, and enjoy collaborative coding in VS Code.

---

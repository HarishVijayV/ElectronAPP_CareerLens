/**
 * Launcher for `npm start`.
 *
 * Running `electron .` directly works from a plain terminal but fails inside
 * VS Code's built-in terminal, which exports ELECTRON_RUN_AS_NODE=1 to every
 * process it spawns (VS Code is itself an Electron app). With that set,
 * Electron boots as plain Node, `require("electron")` hands back a path string
 * instead of the API object, and main.js dies on:
 *
 *     TypeError: Cannot read properties of undefined (reading 'whenReady')
 *
 * So strip the variable, then spawn the real Electron binary. This file runs
 * under Node, where `require("electron")` returning that path is exactly what
 * we want.
 */
const { spawn } = require("child_process");
const electronPath = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electronPath, ["."], { stdio: "inherit", env });
child.on("close", (code) => process.exit(code ?? 0));

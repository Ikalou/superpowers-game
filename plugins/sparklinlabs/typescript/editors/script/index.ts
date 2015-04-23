import ScriptAsset = require("../../data/ScriptAsset");

(<any>window).CodeMirror = require("codemirror");
require("codemirror/addon/search/search");
require("codemirror/addon/search/searchcursor");
require("codemirror/addon/edit/closebrackets");
require("codemirror/addon/comment/comment");
require("codemirror/addon/hint/show-hint");
require("codemirror/keymap/sublime");
require("codemirror/mode/javascript/javascript");
import * as OT from "operational-transform";

let qs = require("querystring").parse(window.location.search.slice(1));
let info = { projectId: qs.project, assetId: qs.asset };
let data: {clientId: number; asset?: ScriptAsset;};
let ui: {
  editor?: CodeMirror.EditorFromTextArea,
  tmpCodeMirrorDoc?: CodeMirror.Doc,
  errorContainer?: HTMLDivElement,

  undoTimeout?: NodeJS.Timer,
  texts?: string[],

  undoStack?: OT.TextOperation[],
  undoQuantityByAction?: number[];
  redoStack?: OT.TextOperation[];
  redoQuantityByAction?: number[];

  sentOperation?: OT.TextOperation;
  pendingOperation?: OT.TextOperation;
} = {};
let socket: SocketIOClient.Socket;

var start = () => {
  socket = SupClient.connect(info.projectId);
  socket.on("welcome", onWelcome);
  socket.on("disconnect", SupClient.onDisconnected);
  socket.on("edit:assets", onAssetEdited);
  socket.on("trash:assets", SupClient.onAssetTrashed);
  SupClient.setupHotkeys();

  window.addEventListener("message", (event) => {
    if (event.data.type == "activate") ui.editor.focus();
  });

  let extraKeys = {
    "F9": () => {},
    "Tab": (cm: any) => {
      if (cm.getSelection() != "") cm.execCommand("indentMore");
      else cm.replaceSelection(Array(cm.getOption("indentUnit") + 1).join(" "));
    },
    "Ctrl-Z": () => { onUndo(); },
    "Cmd-Z": () => { onUndo(); },
    "Shift-Ctrl-Z": () => { onRedo(); },
    "Shift-Cmd-Z": () => { onRedo(); },
    "Ctrl-Y": () => { onRedo(); },
    "Cmd-Y": () => { onRedo(); },
    "Ctrl-S": () => {
      socket.emit("edit:assets", info.assetId, "saveText", (err: string) => { if (err != null) { alert(err); SupClient.onDisconnected(); }});
    },
    "Cmd-S": () => {
      socket.emit("edit:assets", info.assetId, "saveText", (err: string) => { if (err != null) { alert(err); SupClient.onDisconnected(); }});
    },
    "Ctrl-Space": "autocomplete",
    "Cmd-Space": "autocomplete"
  }

  let textArea = <HTMLTextAreaElement>document.querySelector(".code-editor");
  ui.editor = CodeMirror.fromTextArea(textArea, {
    lineNumbers: true, matchBrackets: true, styleActiveLine: true, autoCloseBrackets: true,
    gutters: ["line-error-gutter", "CodeMirror-linenumbers"],
    tabSize: 2, keyMap: "sublime", // , theme: "monokai"
    extraKeys: extraKeys,
    viewportMargin: Infinity,
    mode: "text/typescript"
  });

  ui.tmpCodeMirrorDoc = new CodeMirror.Doc("");
  ui.texts = [];

  ui.undoStack = [];
  ui.undoQuantityByAction = [0];
  ui.redoStack = [];
  ui.redoQuantityByAction = [];

  ui.editor.on("beforeChange", (instance: CodeMirror.Editor, change: any) => {
    if (change.origin === "setValue" || change.origin === "network") return;
    let lastText = instance.getDoc().getValue();
    if (lastText != ui.texts[ui.texts.length-1]) ui.texts.push(lastText);
  });

  (<any>ui.editor).on("changes", onEditText);

  (<any>CodeMirror).registerHelper("hint", "javascript", (editor: CodeMirror.Editor, options: any) => {
    let cursor = editor.getDoc().getCursor()
    let token = editor.getTokenAt(cursor)

    let baseList = ["Sup", "Input", "Math", "Vector3", "Actor", "SpriteRenderer", "Camera", "TileMapRenderer", "loadScene",
      "actor", "spriteRenderer", "camera", "tileMapRenderer", "getLocalPosition", "setLocalPosition"];
    let finalList: string[];

    if (token.string == "") finalList = [];
    else if (token.string == ".") {
      token.start = token.end
      finalList = baseList
    } else {
      finalList = []
      for (let item of baseList) {
        if (item.indexOf(token.string) !== -1) finalList.push(item);
      }
    }

    return { list: finalList, from: (<any>CodeMirror).Pos(cursor.line, token.start), to: (<any>CodeMirror).Pos(cursor.line, token.end) };
  });

  (<any>ui.editor).on("keyup", (instance: any, event: any) => {
    // Ignore Ctrl, Cmd, Escape, Return, Tab, Arrows
    if (event.ctrlKey || event.metaKey || [27, 9, 13, 37, 38, 39, 40].indexOf(event.keyCode) !== -1) return;
    instance.showHint({completeSingle: false});
  });

  let nwDispatcher = (<any>window).nwDispatcher;
  if (nwDispatcher != null) {
    let gui = nwDispatcher.requireNwGui()

    let menu = new gui.Menu()
    menu.append(new gui.MenuItem({
      label: "Cut (Ctrl-X)",
      click: () => { document.execCommand("cut"); }
    }));
    menu.append(new gui.MenuItem({
      label: "Copy (Ctrl-C)",
      click: () => { document.execCommand("copy"); }
    }));
    menu.append(new gui.MenuItem({
      label: "Paste (Ctrl-V)",
      click: () => { document.execCommand("paste"); }
    }));

    document.body.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      menu.popup(event.screenX - gui.Window.get().x, event.screenY - gui.Window.get().y);
      return false;
    });
  }

  ui.errorContainer = <HTMLDivElement>document.querySelector(".error-container");
  ui.errorContainer.querySelector("button").addEventListener("click", () => {
    ui.errorContainer.style.display = "none";
    ui.editor.refresh();
  });

  ui.editor.focus();
}

// Network callbacks
var onWelcome = (clientId: number) => {
  data = { clientId }
  socket.emit("sub", "assets", info.assetId, onAssetReceived);
}

var onAssetReceived = (err: string, asset: any) => {
  data.asset = new ScriptAsset(info.assetId, asset);

  ui.editor.getDoc().setValue(data.asset.pub.draft);
  ui.editor.getDoc().clearHistory();
}

let onAssetCommands: any = {};
var onAssetEdited = (id: string, command: string, ...args: any[]) => {
  (<any>data.asset).__proto__[`client_${command}`].apply(data.asset, args);
  if (onAssetCommands[command] != null) onAssetCommands[command].apply(data.asset, args);
}

onAssetCommands.editText = (operationData: OT.OperationData) => {
  if (data.clientId === operationData.userId) {
    if (ui.pendingOperation != null) {
      socket.emit("edit:assets", info.assetId, "editText", ui.pendingOperation.serialize(), data.asset.document.operations.length, (err: string) => {
        if (err != null) { alert(err); SupClient.onDisconnected(); }
      });

      ui.sentOperation = ui.pendingOperation;
      ui.pendingOperation = null;
    } else ui.sentOperation = null;
    return;
  }

  // Transform operation and local changes
  let operation = new OT.TextOperation();
  operation.deserialize(operationData);

  if (ui.sentOperation != null) {
    [ui.sentOperation, operation] = ui.sentOperation.transform(operation);

    if (ui.pendingOperation != null) [ui.pendingOperation, operation] = ui.pendingOperation.transform(operation);
  }
  ui.undoStack = transformStack(ui.undoStack, operation);
  ui.redoStack = transformStack(ui.redoStack, operation);

  applyOperation(operation.clone(), "network", false);
}

var transformStack = (stack: OT.TextOperation[], operation: OT.TextOperation) => {
  if (stack.length == 0) return stack;

  let newStack: OT.TextOperation[] = [];
  for (let i = stack.length-1; i > 0; i--) {
    let pair = stack[i].transform(operation);
    newStack.push(pair[0]);
    operation = pair[1];
  }
  return newStack.reverse();
}

var applyOperation = (operation: OT.TextOperation, origin: string, moveCursor: boolean) => {
  let cursorPosition = 0;
  let line = 0;
  for (let op of operation.ops) {
    switch (op.type) {
      case "retain": {
        while (true) {
          if (op.attributes.amount <= ui.editor.getDoc().getLine(line).length - cursorPosition) break;

          op.attributes.amount -= ui.editor.getDoc().getLine(line).length + 1 - cursorPosition;
          cursorPosition = 0;
          line++;
        }

        cursorPosition += op.attributes.amount;
        break;
      }
      case "insert": {
        let cursor = ui.editor.getDoc().getCursor();

        let texts = op.attributes.text.split("\n");
        for (let textIndex = 0; textIndex < texts.length; textIndex++) {
          let text = texts[textIndex];
          if (textIndex !== texts.length - 1) text += "\n";
          (<any>ui.editor).replaceRange(text, { line, ch: cursorPosition }, null, origin);
          cursorPosition += text.length;

          if (textIndex != texts.length - 1) {
            cursorPosition = 0;
            line++;
          }
        }

        if (line === cursor.line && cursorPosition === cursor.ch) {
          if (! operation.gotPriority(data.clientId)) {
            for (let i = 0; i < op.attributes.text.length; i++) (<any>ui.editor).execCommand("goCharLeft");
          }
        }

        if (moveCursor) (<any>ui.editor).setCursor(line, cursorPosition);
        break;
      }
      case "delete": {
        let texts = op.attributes.text.split("\n");

        for (let textIndex = 0; textIndex < texts.length; textIndex++) {
          let text = texts[textIndex];
          if (texts[textIndex + 1] != null) (<any>ui.editor).replaceRange("", { line, ch: cursorPosition }, { line: line + 1, ch: 0 }, origin);
          else (<any>ui.editor).replaceRange("", { line, ch: cursorPosition }, { line, ch: cursorPosition + text.length }, origin);

          if (moveCursor) (<any>ui.editor).setCursor(line, cursorPosition);
        }
        break;
      }
    }
  }
}


onAssetCommands.saveText = (errors: Array<{file: string; position: {line: number; character: number;}; length: number; message: string}>, own: boolean) => {
  // Remove all previous erros
  for (let textMarker of ui.editor.getDoc().getAllMarks()) {
    if ((<any>textMarker).className !== "line-error") continue;
    textMarker.clear();
  }

  for (let line = 0; line < ui.editor.getDoc().lineCount(); line++) ui.editor.setGutterMarker(line, "line-error-gutter", null);

  // Display new ones
  if (errors.length === 0) {
    ui.errorContainer.style.display = "none";
    ui.editor.refresh();
    return;
  }

  ui.errorContainer.style.display = "flex";
  ui.editor.refresh();

  let text = <HTMLTextAreaElement>ui.errorContainer.querySelector("textarea");
  text.value = "";
  for (let error of errors) {
    text.value += `${error.file}(${error.position.line+1}): ${error.message}\n`;

    if (! own) continue;

    let line = error.position.line;
    ui.editor.getDoc().markText(
      { line , ch: error.position.character },
      { line, ch: error.position.character + error.length },
      { className: "line-error" }
    );

    let gutter = document.createElement("div");
    gutter.className = "line-error-gutter";
    gutter.innerHTML = "●";
    ui.editor.setGutterMarker(line, "line-error-gutter", gutter);
  }
}

// User interface
var onEditText = (instance: CodeMirror.Editor, changes: CodeMirror.EditorChange[]) => {
  let undoRedo = false;

  let operationToSend: OT.TextOperation;
  for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
    let change = changes[changeIndex];
    let origin: string = (<any>change).origin;

    // Modification from an other person
    if (origin === "setValue" || origin ==="network") continue;

    ui.tmpCodeMirrorDoc.setValue(ui.texts[changeIndex]);

    let operation = new OT.TextOperation(data.clientId);
    for (let line = 0; line < change.from.line; line++) operation.retain(ui.tmpCodeMirrorDoc.getLine(line).length + 1);
    operation.retain(change.from.ch);

    let offset = 0;
    if (change.removed.length !== 1 || change.removed[0] !== "") {
      for (let index = 0; index < change.removed.length; index++) {
        let text = change.removed[index];
        if (index !== 0) {
          operation.delete("\n");
          offset += 1;
        }

        operation.delete(text);
        offset += text.length;
      }
    }

    if (change.text.length !== 1 || change.text[0] !== "") {
      for (let index = 0; index < change.text.length; index++) {
        if (index !== 0) operation.insert("\n");
        operation.insert(change.text[index]);
      }
    }

    let beforeLength = (operation.ops[0].attributes.amount != null) ? operation.ops[0].attributes.amount : 0;
    operation.retain(ui.tmpCodeMirrorDoc.getValue().length - beforeLength - offset);

    if (operationToSend == null) operationToSend = operation.clone();
    else operationToSend = operationToSend.compose(operation);

    if (origin === "undo" || origin === "redo") undoRedo = true;
  }

  ui.texts.length = 0;
  if (operationToSend == null) return;

  if (! undoRedo) {
    if (ui.undoTimeout != null) {
      clearTimeout(ui.undoTimeout);
      ui.undoTimeout = null;
    }

    ui.undoStack.push(operationToSend.clone().invert());
    ui.undoQuantityByAction[ui.undoQuantityByAction.length-1] += 1;
    if (ui.undoQuantityByAction[ui.undoQuantityByAction.length-1] > 20) ui.undoQuantityByAction.push(0);
    else {
      ui.undoTimeout = <any>setTimeout( () => {
        ui.undoTimeout = null;
        ui.undoQuantityByAction.push(0);
      }, 500);
    }

    ui.redoStack.length = 0;
    ui.redoQuantityByAction.length = 0;
  }

  if (ui.sentOperation == null) {
    socket.emit("edit:assets", info.assetId, "editText", operationToSend.serialize(), data.asset.document.operations.length, (err: string) => {
      if (err != null) { alert(err); SupClient.onDisconnected(); }
    });

    ui.sentOperation = operationToSend;
  } else {
    if (ui.pendingOperation != null) ui.pendingOperation = ui.pendingOperation.compose(operationToSend);
    else ui.pendingOperation = operationToSend;
  }
}

var onUndo = () => {
  if (ui.undoStack.length == 0) return;

  if (ui.undoQuantityByAction[ui.undoQuantityByAction.length-1] === 0) ui.undoQuantityByAction.pop();
  let undoQuantityByAction = ui.undoQuantityByAction[ui.undoQuantityByAction.length-1];

  for (let i = 0; i < undoQuantityByAction; i++) {
    let operationToUndo = ui.undoStack[ui.undoStack.length-1];
    applyOperation(operationToUndo.clone(), "undo", true);

    ui.undoStack.pop()
    ui.redoStack.push(operationToUndo.invert());
  }

  if (ui.undoTimeout != null) {
    clearTimeout(ui.undoTimeout);
    ui.undoTimeout = null;
  }

  ui.redoQuantityByAction.push(ui.undoQuantityByAction[ui.undoQuantityByAction.length-1]);
  ui.undoQuantityByAction[ui.undoQuantityByAction.length-1] = 0;
}

var onRedo = () => {
  if (ui.redoStack.length === 0) return;

  let redoQuantityByAction = ui.redoQuantityByAction[ui.redoQuantityByAction.length-1]
  for (let i = 0; i < redoQuantityByAction; i++) {
    let operationToRedo = ui.redoStack[ui.redoStack.length-1];
    applyOperation(operationToRedo.clone(), "undo", true);

    ui.redoStack.pop()
    ui.undoStack.push(operationToRedo.invert());
  }

  if (ui.undoTimeout != null) {
    clearTimeout(ui.undoTimeout);
    ui.undoTimeout = null;

    ui.undoQuantityByAction.push(ui.redoQuantityByAction[ui.redoQuantityByAction.length-1]);
  }
  else ui.undoQuantityByAction[ui.undoQuantityByAction.length-1] = ui.redoQuantityByAction[ui.redoQuantityByAction.length-1];

  ui.undoQuantityByAction.push(0);
  ui.redoQuantityByAction.pop();
}

// Start
start();

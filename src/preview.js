const messages = document.querySelector("#messages");
const error = document.querySelector("#error");
const payload = document.querySelector("#payload");
let token = "";
let template;
let latestCard;
const openDetails = new Set();
const visibleContainers = new Set();
const formValues = new Map();

function showError(message) {
  error.textContent = message;
  error.hidden = false;
}

async function sendActivity(data, invoke = false) {
  error.hidden = true;
  const body = { ...template, id: crypto.randomUUID(), timestamp: new Date().toISOString() };
  if (typeof data === "string") {
    body.type = "message";
    body.text = data;
  } else {
    delete body.text;
    if (invoke) {
      body.type = "invoke";
      body.name = "adaptiveCard/action";
      body.value = { action: { type: "Action.Execute", verb: "bridge", data }, trigger: "manual" };
    } else {
      body.type = "message";
      body.value = data;
    }
  }
  const response = await fetch("/activity", {
    method: "POST", headers: { "content-type": "application/json", "x-simulator-token": token }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
}

function element(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

async function performAction(action, scope, prefix) {
  if (action.type === "Action.ToggleVisibility") {
    for (const target of action.targetElements || []) {
      const key = `${prefix}:${typeof target === "string" ? target : target.elementId}`;
      const container = document.getElementById(key);
      if (container) {
        container.hidden = !container.hidden;
        container.hidden ? visibleContainers.delete(key) : visibleContainers.add(key);
      }
    }
    return;
  }
  if (action.type !== "Action.Execute" && action.type !== "Action.Submit") throw new Error("Unsupported MOCK action.");
  const data = { ...action.data };
  if (action.associatedInputs !== "none") {
    for (const input of scope.querySelectorAll("input,textarea,select")) {
      if (input.name) data[input.name] = input.value;
    }
  }
  await sendActivity(data, action.type === "Action.Execute");
}

function bindAction(control, action, scope, prefix, selectable = false) {
  let busy = false;
  const activate = async (event) => {
    const interactive = event.target.closest("button,a,input,textarea,select,summary,[role='button']");
    if (busy || (interactive && interactive !== control)) return;
    busy = true;
    control.disabled = true;
    control.setAttribute("aria-disabled", "true");
    try { await performAction(action, scope, prefix); } catch (failure) { showError(failure.message); }
    finally {
      busy = false;
      control.disabled = false;
      control.setAttribute("aria-disabled", "false");
    }
  };
  control.addEventListener("click", activate);
  if (selectable) {
    control.classList.add("selectable");
    control.tabIndex = 0;
    control.setAttribute("role", "button");
    control.setAttribute("aria-label", action.tooltip || action.title);
    control.addEventListener("keydown", (event) => {
      if (event.target !== control || event.repeat || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      return activate(event);
    });
  }
}

function actions(actions, parent, scope, prefix) {
  const group = element("div", undefined, "action-set");
  for (const action of actions || []) {
    if (action.type === "Action.ShowCard") {
      const details = element("details");
      const key = `${prefix}:${action.title}`;
      details.open = openDetails.has(key);
      details.addEventListener("toggle", () => details.open ? openDetails.add(key) : openDetails.delete(key));
      details.append(element("summary", action.title));
      const form = element("div");
      for (const entry of action.card?.body || []) render(entry, form, form, prefix);
      actionsRender(action.card?.actions, form, form, prefix);
      details.append(form);
      group.append(details);
      continue;
    }
    const button = element("button", action.title);
    button.type = "button";
    if (action.style === "default") button.classList.add("quiet");
    bindAction(button, action, scope, prefix);
    group.append(button);
  }
  parent.append(group);
}
const actionsRender = actions;

function render(entry, parent, scope, prefix) {
  if (entry.type === "TextBlock") {
    const classes = ["text-block", entry.size?.toLowerCase(), entry.weight === "Bolder" ? "bold" : "",
      entry.isSubtle ? "subtle" : "", entry.fontType === "Monospace" ? "mono" : "", entry.color?.toLowerCase()].filter(Boolean).join(" ");
    const text = element("div", entry.text, classes);
    if (entry.id) text.id = `${prefix}:${entry.id}`;
    if (Number.isSafeInteger(entry.maxLines) && entry.maxLines > 0) {
      text.style.display = "-webkit-box";
      text.style.webkitBoxOrient = "vertical";
      text.style.webkitLineClamp = String(entry.maxLines);
      text.style.overflow = "hidden";
    }
    parent.append(text);
  } else if (entry.type === "Container") {
    const container = element("div", undefined, "native-container");
    if (entry.id) {
      container.id = `${prefix}:${entry.id}`;
      container.hidden = entry.isVisible === false && !visibleContainers.has(container.id);
    }
    for (const child of entry.items || []) render(child, container, scope, prefix);
    if (entry.selectAction) bindAction(container, entry.selectAction, scope, prefix, true);
    parent.append(container);
  } else if (entry.type === "ColumnSet") {
    const row = element("div", undefined, "card-columns");
    for (const column of entry.columns || []) {
      const cell = element("div", undefined, column.width === "auto" ? "card-column-auto" : "card-column-stretch");
      for (const child of column.items || []) render(child, cell, scope, prefix);
      row.append(cell);
    }
    if (entry.selectAction) bindAction(row, entry.selectAction, scope, prefix, true);
    parent.append(row);
  } else if (entry.type === "ActionSet") {
    actionsRender(entry.actions, parent, scope, prefix);
  } else if (entry.type === "FactSet") {
    const list = element("dl");
    for (const fact of entry.facts || []) list.append(element("dt", fact.title), element("dd", fact.value));
    parent.append(list);
  } else if (entry.type === "Input.Text" || entry.type === "Input.ChoiceSet") {
    const key = `${prefix}:${entry.id}`;
    const label = element("label", entry.label || entry.id);
    label.htmlFor = key;
    let input;
    if (entry.type === "Input.ChoiceSet") {
      input = element("select");
      const empty = element("option", "Choose...");
      empty.value = "";
      input.append(empty);
      for (const choice of entry.choices || []) {
        const option = element("option", choice.title);
        option.value = choice.value;
        input.append(option);
      }
    } else {
      input = element(entry.isMultiline ? "textarea" : "input");
      if (entry.maxLength) input.maxLength = entry.maxLength;
    }
    input.id = key;
    input.name = entry.id;
    input.value = formValues.get(key) ?? entry.value ?? "";
    input.addEventListener("input", () => formValues.set(key, input.value));
    parent.append(label, input);
    if (entry.inlineAction) actionsRender([entry.inlineAction], parent, scope, prefix);
  }
}

function publish(item) {
  let surface = document.getElementById(item.id);
  if (!surface) {
    surface = element("article", undefined, "message");
    surface.id = item.id;
    messages.append(surface);
  }
  surface.replaceChildren();
  if (item.message.type === "text") {
    surface.className = "message text";
    const presentation = item.message.presentation;
    if (presentation?.version === 2) {
      surface.append(element("div", presentation.title, "bold"));
      if (presentation.kind !== "session") surface.append(element("div",
        presentation.kind === "background" ? "Background reply" : "Control reply", "small subtle"));
      if (presentation.parts > 1) surface.append(element("div",
        `Reply ${presentation.groupId.slice(0, 8)} · ${presentation.part}/${presentation.parts}`, "small subtle"));
      surface.append(element("div", item.message.text, "text-block"));
    } else surface.textContent = item.message.text;
  } else {
    surface.className = "message";
    latestCard = item.message.card;
    for (const entry of latestCard.body || []) render(entry, surface, surface, item.id);
    actionsRender(latestCard.actions, surface, surface, item.id);
    payload.textContent = JSON.stringify(latestCard, null, 2);
  }
}

document.querySelector("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const prompt = document.querySelector("#prompt");
  if (!prompt.value) return;
  const text = prompt.value;
  prompt.value = "";
  try { await sendActivity(text); } catch (failure) { showError(failure.message); }
});
document.querySelector("#payload-toggle").addEventListener("click", () => { payload.hidden = !payload.hidden; });
for (const name of ["ask", "permission", "plan", "form", "background", "long", "error"]) {
  const button = element("button", name);
  button.type = "button";
  button.addEventListener("click", () => {
    document.querySelector("#prompt").value = name;
    document.querySelector("#prompt").focus();
  });
  document.querySelector("#scenarios").append(button);
}

try {
  const response = await fetch("/bootstrap");
  const bootstrap = await response.json();
  if (!response.ok || bootstrap.mock !== true) throw new Error("Expected an explicit MOCK simulator.");
  token = bootstrap.token;
  template = bootstrap.template;
  bootstrap.messages.forEach(publish);
  const stream = new EventSource("/events");
  stream.onmessage = (event) => publish(JSON.parse(event.data));
  stream.onopen = () => { document.querySelector("#connection").textContent = "Live SSE connected - no polling"; };
  stream.onerror = () => { document.querySelector("#connection").textContent = "SSE disconnected - backend may be stopped"; };
} catch (failure) {
  showError(failure.message);
}

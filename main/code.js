var escapable =
  /[\x00-\x1f\ud800-\udfff\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufff0-\uffff]/g;
let outputStream, inputStream;
let inputDone, outputDone;
var eb;
var port;
let socket;
let reconnectInterval = 3000; // 3 seconds
let maxRetries = 5;
let retryCount = 0;

function filterUnicode(quoted) {
  escapable.lastIndex = 0;
  if (!escapable.test(quoted)) return quoted;

  return quoted.replace(escapable, function (a) {
    return "";
  });
}

var EveBrain = function () {
  this.cbs = {};
  // Initially, set connected to true if there is a port.
  if (port) {
    this.connected = true;
  } else {
    this.connected = false;
  }
};

EveBrain.prototype = {
  send_msg: function (message, callback) {
    message.id = Math.random().toString(36).substring(2, 12);

    //set the callback function to run when message recieves a reply
    if (callback) {
      this.cbs[message.id] = callback;
    }

    //check how message is formed and turn into json string
    if (!(message instanceof Object)) {
      message = JSON.stringify(JSON.parse(message));
    } else {
      message = JSON.stringify(message);
    }

    //Check USB or WS connection, favor WS, and send appropriatley
    if (socket && socket.readyState === WebSocket.OPEN) {
      sendDataWS(message);
    } else {
      sendDataUSB(message);
    }
  },

  doCallback: function (message) {
    //run the callback
    if (!(typeof message.id === "undefined")) {
      try {
        this.cbs[message.id](message);
      } catch (e) {}
    }
  },
};

async function USBconnect() {
  // Request & open port here.
  port = await navigator.serial.requestPort();

  if (eb) {
    eb.connected = true;
  }
  // Wait for the port to open.
  await port.open({ baudRate: 230400 });
  // on disconnect, alert user and pause Snap!
  port.addEventListener("disconnect", (event) => {
    if (eb) {
      eb.connected = false; // signal disconnection to other code.
    }
  });

  // Setup the output stream
  const encoder = new TextEncoderStream();
  outputDone = encoder.readable.pipeTo(port.writable);
  outputStream = encoder.writable;

  // Make stream
  let decoder = new TextDecoderStream();
  inputDone = port.readable.pipeTo(decoder.writable);
  inputStream = decoder.readable;

  reader = inputStream.getReader();
  readLoop(); // Start infinite read loop
}

/**
 * This reads from the serial in a loop, and
 * runs the given callbacks (using ebUSB).
 */
async function readLoop() {
  let buffer = "";
  console.log("USB Reader Listening...");

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      console.log("[readLoop] DONE");
      reader.releaseLock();
      break;
    }

    buffer += value;
    console.log(value + "\n");

    let messages = { parsed: [] };
    let jsons = buffer.split("\r\n");

    buffer = jsons.pop(); // Keep potential incomplete JSON

    for (let json of jsons) {
      try {
        let response = JSON.parse(json);
        if (response && typeof response === "object") {
          messages.parsed.push(response);
        }
      } catch (e) {
        console.error("Failed to parse JSON:", e);
      }
    }

    messages.parsed.forEach((message) => {
      displayMessage(JSON.stringify(message));
      if (typeof eb !== "undefined") {
        eb.doCallback(message);
      }
    });
  }
}

function writeToStream(...lines) {
  // Write to output stream
  const writer = outputStream.getWriter();
  lines.forEach((line) => {
    console.log("[SEND]", line);
    writer.write(line + "\n");
  });
  writer.releaseLock();
}

async function sendDataUSB(msg) {
  if (!outputStream) {
    console.error("No serial connection established.");
    return;
  }
  try {
    message = filterUnicode(msg);
    writeToStream(message);
  } catch (err) {
    console.error("Invalid JSON format:", err);
  }
}

async function sendDataWS(data) {
  message = filterUnicode(data);
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(message);
      displayMessage("Data sent:", data);
    } catch (err) {
      console.error("Invalid JSON format:", err);
    }
  } else {
    displayMessage("Cannot send data, WebSocket is not open.");
  }
}

function connect(url) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    displayMessage("Already connected.");
    return;
  }

  console.log("Attempting to connect to ESP8266 WebSocket...");
  socket = new WebSocket(url);

  socket.onopen = function () {
    displayMessage("Connected to ESP8266 WebSocket");
    retryCount = 0; // Reset retry count on successful connection
  };

  socket.onmessage = function (event) {
    displayMessage("Message from ESP8266: " + event.data);
    if (typeof eb !== "undefined") {
      eb.doCallback(event.data);
    }
  };

  socket.onerror = function (error) {
    displayMessage("WebSocket error: " + error);
  };

  socket.onclose = function (event) {
    displayMessage("WebSocket closed: " + event);
    if (retryCount < maxRetries) {
      retryCount++;
      displayMessage(
        `Reconnecting in ${reconnectInterval / 1000} seconds... (Attempt ${retryCount}/${maxRetries})`
      );
      setTimeout(() => connect(url), reconnectInterval);
    } else {
      displayMessage(
        "Max reconnect attempts reached. Manual reconnection required."
      );
    }
  };
}

function displayMessage(data) {
  document.getElementById("output").textContent += data + "\n";
}

function displayIP(ip) {
  document.getElementById("ip").innerHTML = ip;
}

function getDisplayIP() {
  return document.getElementById("ip").innerHTML;
}

function getIP() {
  var message = { cmd: "getConfig" };
  //JSON Command, Function to do on successful completion (where rtnMsg is the returned message of the complete command)
  eb.send_msg(message, function (rtnMsg) {
    displayIP(rtnMsg.msg.sta_ip);
  });
}

function connectionWizard() {
  let ssid = document.getElementById("ssid").value;
  // Workaround to allow ssid input
  if (ssid === "") {
    ssid = document.getElementById("ssidText").value;
  }
  const pass = document.getElementById("pass").value;
  var message = {
    cmd: "setConfig",
    arg: { sta_ssid: ssid, sta_pass: pass },
  };
  //JSON Command, Function to do on successful completion (where rtnMsg is the returned message of the complete command)
  eb.send_msg(message, function (rtnMsg) {
    displayIP(rtnMsg.msg.sta_ip);
  });
}

function wifiCheck() {
  eb.send_msg({ cmd: "startWifiScan" }, function (rtnMsg) {
    var wifi = "";
    if (typeof rtnMsg.msg === "undefined") {
      return;
    }
    console.log(rtnMsg);
    for (var i = 0; i < rtnMsg.msg.length; i++) {
      wifi += "<option value ='" + rtnMsg.msg[i][0] + "' >";
      wifi += rtnMsg.msg[i][0];
      wifi += "</option>";
    }
    console.log("hello there");
    document.getElementById("ssid").innerHTML = wifi;
  });
}

function connectWS() {
  var url = "ws://" + getDisplayIP() + ":8899/websocket";
  displayMessage("...conecting: " + url);
  connect(url);
}

function sendJsonText() {
  const jsonInput = document.getElementById("jsonInput").value;
  eb.send_msg(jsonInput, function (rtnMsg) {});
}

function GPIO_ON() {
  pinOn = document.getElementById("pinOn").value;
  var message = {
    cmd: "gpio_on",
    arg: pinOn,
  };
  //JSON Command, Function to do on successful completion (where rtnMsg is the returned message of the complete command)
  eb.send_msg(message, function (rtnMsg) {
    console.log("GPIO Turned on");
  });
}

function GPIO_OFF() {
  pinOff = document.getElementById("pinOff").value;
  var message = {
    cmd: "gpio_off",
    arg: pinOff,
  };

  console.log(message);
  //JSON Command, Function to do on successful completion (where rtnMsg is the returned message of the complete command)
  eb.send_msg(message, function (rtnMsg) {
    console.log("GPIO Turned off");
  });
}

eb = new EveBrain();
document.getElementById("connectButton").addEventListener("click", USBconnect);
document.getElementById("wifichkButton").addEventListener("click", wifiCheck);
document.getElementById("sendButton").addEventListener("click", sendJsonText);
document
  .getElementById("wifiButton")
  .addEventListener("click", connectionWizard);
document.getElementById("socketButton").addEventListener("click", connectWS);
document.getElementById("ipButton").addEventListener("click", getIP);
document.getElementById("GPIO_ON").addEventListener("click", GPIO_ON);
document.getElementById("GPIO_OFF").addEventListener("click", GPIO_OFF);

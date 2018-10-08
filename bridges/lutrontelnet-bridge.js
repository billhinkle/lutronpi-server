// ISC License (ISC) / portions Copyright 2017 Nate Schwartz, Copyright 2018 William Hinkle
// Permission to use, copy, modify, and/or distribute this software for any purpose
// with or without fee is hereby granted, provided that the above copyright notice and
// this permission notice appear in all copies.
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO
// THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS.
// IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
// CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR
// PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
// ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
//
// ref v 1.1.0  lutronpro (original)		nate schwartz (github njscwartz)  with ICS license
// ref v 2.0.0+ lutronpi (forked)			wjh Bill hinkle (github billhinkle)
// v 1.0.0	2018.10.08 1200Z				wjh  Bill Hinkle (github billhinkle)
//			bridge code for Lutron Integration Protocol (LIP) Telnet-only interface
//			e.g. for Radio RA, Homeworks QS etc.
//
'use strict';
module.exports = {
	Bridge
};

// const assert = require('assert');

const log = require('loglevel');
log.setLevel('info')

const net = require('net');
const tls = require('tls');
const crc32 = require('crc-32');

const eventEmitter = require('events');

// bridge events
const BE_GOTDEVICES = 'gotdevices';
const BE_GOTZLEVEL = 'gotzlevel'; // append bridge:zone indices

const LB_REQUEST_TIMEOUT = 1500;
const LB_RESPONSE_TIMEOUT = 3000;
const LB_AUTH_TIMEOUT = 10000;
const LB_RECONNECT_DELAY_RESET = 30000;
const LB_RECONNECT_DELAY_AUTHFAIL = 15000;
const LB_RECONNECT_DELAY_NORMMAX = 75000;
const LB_RECONNECT_DELAY_LONG = 7500;
const LB_RECONNECT_DELAY_SHORT = 500;
const LB_TELNET_RETRY_INTERVAL = 300000;
const LB_PING_INTERVAL = 90000;
const LB_POLL_INTERVAL = 290000;

const PICO_HELD_TIMEOUT = 6050; //milliseconds
const PICO_PUSH_TIME_DEFAULT = 300;
const PICO_REPEAT_TIME_DEFAULT = 750;
var picoActive = {}; // list object of active picos keyed by pico ID
var picoEvents = new eventEmitter();

const BUTTON_VIRTUAL_DEVICEN = 1	// virtual buttons use the bridge's device #, else it is a Pico
const BUTTON_OP_PRESS = 3;
const BUTTON_OP_RELEASE = 4;
const BUTTON_OP_HOLD = 5;
const BUTTON_OP_DBLTAP = 6;
const BUTTON_OP_HOLDRELEASE = 32;
const BUTTON_FORCE = Object.freeze({
	NONE: 0,
	PRESS_RELEASE: 1,
	HOLD_RELEASE: 2,
	LONG_RELEASE: 3
});

const LIP_CMD_OUTPUT_REQ = 1;
const LIP_CMD_OUTPUT_SET = 1;
const LIP_CMD_OUTPUT_RAISE = 2;
const LIP_CMD_OUTPUT_LOWER = 3;
const LIP_CMD_OUTPUT_STOP = 4;

// --- Polyfills to make Node 6.11 happy
// String .startsWith polyfill
if (!String.prototype.startsWith) {
	String.prototype.startsWith = function(search, pos) {
		return this.substr(!pos || pos < 0 ? 0 : +pos, search.length) === search;
	};
}
// Object .values polyfill
Object.values = Object.values || (obj => Object.keys(obj).map(key => obj[key]));
// --- end Polyfills

// object representing an active Pico (or virtual button for scene)
function PicoActive(picoBridge, picoDevice, picoButtonNumber, picoButtonForceRelease, picoPushTime, picoRepeatTime) {
	this.picoID = picoID(picoBridge.bridgeID, picoDevice, picoButtonNumber);
	this.bridge = picoBridge;
	this._picoDevice = picoDevice;
	this._picoButtonNumber = picoButtonNumber;

	this._logger = picoBridge._logger;

	this.forceRelease = picoButtonForceRelease;
	this.pushTime = picoPushTime;
	this.repeatTime = picoRepeatTime;

	this.timerHeld;
	this.timerRelease;
	this.intervalRamp;
	this.wasRamped;

	var startTime;
	this.Init = function() {
		startTime = new Date().getTime();
		this.wasRamped = false;
	}
	this.Init();

	this.elapsed = function() {
		return (startTime) ? (new Date().getTime() - startTime) : 0;
	}
}
PicoActive.prototype.timerQuash = function() {
	if (this.timerHeld) {
		clearTimeout(this.timerHeld);
		this.timerHeld = null;
	}
	if (this.timerRelease) {
		clearTimeout(this.timerRelease);
		this.timerRelease = null;
	}
	if (this.intervalRamp) {
		clearInterval(this.intervalRamp);
		this.intervalRamp = null;
	}
	picoEvents.removeAllListeners(this.picoID);
}
PicoActive.prototype.restart = function() {
	this.timerQuash();
	this.Init();
}
PicoActive.prototype.reportOp = function(picoOpName) {
	return picoReportJSONFormatter(this.bridge, this._picoDevice, this._picoButtonNumber, picoOpName);
}

function picoID(lbridgeID, picoDevice, picoButtonNumber) {
	return lbridgeID + ":" + picoDevice + ":" + picoButtonNumber;
}

function picoReportJSONFormatter(picoBridge, picoDevice, picoButtonNumber, picoOpName) { 
	return {
		Header: {
			MessageBodyType: "ButtonAction",
			Bridge: picoBridge.bridgeID
		},
		Body: {
			SerialNumber: (picoDevice == BUTTON_VIRTUAL_DEVICEN) ?
							picoBridge.bridgeID :
							Object.keys(picoBridge._picoList)[Object.values(picoBridge._picoList)
								.findIndex(function(p) {
									return p.ID == picoDevice
								})
							],
			ID: picoDevice,
			Button: picoButtonNumber,
			Action: picoOpName
		}
	};
}

function eventZoneLevel(bridgeID, deviceZone) {
	return BE_GOTZLEVEL + ':' + bridgeID + ':' + deviceZone;
}

// object representing Lutron Radio RA, Homework QS, etc. controller/router
function Bridge( lbridgeix, lbridgeid, lbridgeip, sendHubJSON, sentHubEvents ) {
	this.bridgeIX = lbridgeix;
	this.bridgeBrand = 'Lutron';
	this.bridgeType = 'lutrontelnet';
	this.bridgeID = lbridgeid;
	this.bridgeIP = lbridgeip;
	this.initialized = false;

	this._logger = log.getLogger(lbridgeid);

	this._sendHubJSON = (typeof sendHubJSON === 'function') ? sendHubJSON : function() {this._logger.warn('No ST hub comm function assigned!');};
    this._sentHubEvents = sentHubEvents ? sentHubEvents : null;	// listen to 'sheSent' to eavesdrop on all unsolicitied bridge events sent to ST hub

	this._authorizer = null;
	this._reconnectTries = 0;

	this._bridgeSN = '';
	this._bridgeModel = '';

	this._telnetClient = null;
	this._telnetInSession = false;
	this._telnetLogin = '';
	this._telnetPassword = '';

	this._allDevices = [];
	this._allScenes = [];
	this._picoList = {}; // map Pico SN to lip ID, button details & mode (sent from SmartThings)
	this._zoneList = {
		device: [],
		isShade: []
	}; // map lighting/shade zones to device and type lighting vs shade

	this._expectedResponseCnt = 0;
	this._expectPingback = false;
	this._flipPingTag = false;
	this._intervalPing = null;
	this._timerResponse = null;
	this._timerBackoff = null;
	this._intervalTelnetRetryPending = null;
// these might be used later for device list XML handler
//	this._intervalBridgePoll = null;
//	this._expectPollDevices = false;
//	this._expectPollScenes = false;
//	this._digestLeap = '';
//	this._digestScenes = '';
	this._dReqDeviceListCallback = [];
	this._dReqSceneListCallback = [];

	this._updatedDevices = false;
	this._updatedScenes = false;

	this._bridgeEvents = new eventEmitter();


	/*
	// just an example of eavesdropping on unsolicited bridge events sent to SmartThings
	if (this._sentHubEvents)
		this._sentHubEvents.on('sheSent', function stechotest(jsonData) {
			this._logger.info('ST echo: %o', jsonData);
		}.bind(this));
	*/

	// command-line options relevant to this bridge are as 'bridgeID=string' (may be multiple)
	this._options = {};		// command-line options
	let opttag = this.bridgeID + '=';
	for (let a=2; a < process.argv.length; a++) {
		if (process.argv[a].startsWith(opttag)) {
			let opt = process.argv[a].substr(opttag.length).toLowerCase();
			this._options[opt] = true;
		}
	}

	// set option higher-detail logging per CLI options trace/debug
	if (this._options.trace) {
		this._logger.setLevel('trace');
	} else if (this._options.debug) {
		this._logger.setLevel('debug');
	}

	this._logger.info('%s Bridge %s at %s created: #%d', this.bridgeBrand, this.bridgeID, this.bridgeIP, this.bridgeIX);
	if (Object.keys(this._options).length)
		this._logger.info('Bridge options: %o', this._options);
}
Bridge.prototype._expectResponse = function(expectedresponseincr) {
	// track the minimum number of bridge responses expected and try to reconnect on failure
	// parameter: expectedresponseinc:
	//		not passed/undefined = return pending minimum response count
	//		false/0 = reset and disable expected response monitor
	//		+/-N = add or subtract N from pending minimum response count
	this._logger.trace("expectedResponseCnt = %d, expectedresponseincr = %d",this._expectedResponseCnt,expectedresponseincr);

	if (expectedresponseincr !== undefined) {
		if (expectedresponseincr && expectedresponseincr > 0) {
			this._expectedResponseCnt += Math.trunc(expectedresponseincr);
			if (this._timerResponse != null)
				clearTimeout(this._timerResponse);
			this._timerResponse = setTimeout(function lbResponseTimeout() {
				this._logger.error('Lutron Bridge %s #%d isn\'t responding [%d]', this.bridgeID, this.bridgeIX,
					this._expectedResponseCnt);
				this._reconnect(true, LB_RECONNECT_DELAY_SHORT);
			}.bind(this), LB_RESPONSE_TIMEOUT);
		}
		else {
			if (!expectedresponseincr) // unconditional disable & reset of response timeout
				this._expectedResponseCnt = 0;
			else
				this._expectedResponseCnt += Math.trunc(expectedresponseincr);
			if (this._expectedResponseCnt <= 0) {
				this._expectedResponseCnt = 0;
				if (this._timerResponse != null)
					clearTimeout(this._timerResponse);
			}
		}
	}
	return this._expectedResponseCnt;
}
Bridge.prototype._reconnect = function(attemptresume, backoffms) {
	this._expectResponse(false);
	// kill the current pinger
	this._expectPingback = false;
	clearInterval(this._intervalPing);
	if (this._timerBackoff)		// limit to one pending reconnect at a time
		clearTimeout(this._timerBackoff);
	// wait a bit before trying to reconnect to the bridge
	this._timerBackoff = setTimeout(function() {
		this._timerBackoff = null;
		this._logger.info("Lutron Bridge %s reconnecting...     ", this.bridgeID);
		this._telnetInSession = false;
		if (this._telnetConnected()) {
			this._telnetClient.on('close', function() {
				this._telnetInit();
			}.bind(this));
			this._telnetClient.destroy();
			/* 	this._telnetClient = null; */
		} else
			this._telnetInit();
	}.bind(this), backoffms);
}
Bridge.prototype._telnetInit = function(telnetInSessionCallback) {
	if (!this._telnetInSession) {
		this._logger.info('Starting Telnet connection to Lutron Bridge %s', this.bridgeID);
		this._telnetInSession = false;
		if (this._telnetConnected())
			this._telnetClient.destroy();
		this._telnetClient = new net.Socket();
		this._telnetHandler(telnetInSessionCallback);
	}
}
Bridge.prototype._telnetConnected = function() {
	return (!!this._telnetClient && !this._telnetClient.destroyed);
}
Bridge.prototype._telnetWrite = function(data) {
	this._logger.debug('Lutron Bridge %s Telnet sent: %s', this.bridgeID, data);

	if (!this._telnetClient) {
		this._telnetInit(function lbResumeTelnetOnWrite() {
			this._telnetClient.write(data);
		}.bind(this));
	}
	else
		this._telnetClient.write(data);
}
Bridge.prototype._telnetHandler = function(telnetInSessionCallback) {
	this._telnetClient.on('data', function(data) {
		var msgline;
		var message;

		this._logger.trace('Lutron Bridge %s Telnet received: Bridge %s', this.bridgeID, data);
		// we have to account for GNET> prompts embedded within responses, and multiple-line responses
		message = data.toString();
		if ((message.indexOf('GNET>') !== -1) || (message.indexOf('QNET>') !== -1)) { // a prompt, but it might've been embedded so reprocess line also
			if (!this._telnetInSession) { // first prompt upon connection
				_telnetSessionConfirmed.call(this, telnetInSessionCallback);
			}
			else { // likely a ping, note that we did get a ping response
				// currently taking a GNET> or QNET> prompt as a ping response, but we COULD instead send
				// ?SYSTEM,10 and get back  ~SYSTEM,12/28/2017,14:40:06  e.g.
				this._expectResponse(-1);
				this._expectPingback = false;
				// visual Ping sugar only
				this._flipPingTag = !this._flipPingTag;
				process.stdout.write('Pinged Bridge ' + this.bridgeID + ' ' + (this._flipPingTag ?	'T' : 't') + '\r');
			}
			// now remove the prompt(s) and continue processing the data
			message = message.replace(/[GQ]NET\>\s/g, '');
		}
		msgline = message.match(/^.*((\r\n|\n|\r|\s)|$)/gm); // break up multiple & concatenated lines

		for (var i = 0, mlcnt = msgline.length; i < mlcnt; i++) {
			if (msgline[i].length)
				this._logger.debug('Lutron Bridge %s Telnet received: %s', this.bridgeID, msgline[i]);
			if (msgline[i].indexOf('login') !== -1) {
				this._telnetWrite(this._telnetLogin + '\r\n');
			}
			else if (msgline[i].indexOf('password') !== -1) {
				this._telnetWrite(this._telnetPassword + '\r\n');
			}
			else if (msgline[i].indexOf('~OUTPUT') !== -1) { // dimmer/switch level report
				var extUpdate = false;
				if (this._expectResponse()) {
					this._expectResponse(-1); // we've received an expected response (probably!)
				}
				else
					extUpdate = true;
				this._logger.info('Lutron Bridge %s sent (%s) device update', this.bridgeID, extUpdate?'manual/app':'requested' );

				message = msgline[i].split(',');

				var deviceID = Number(message[1]);
				var dimmerLevel = Number(message[3]);
				if (!dimmerLevel)
					dimmerLevel = 0;
				else
					dimmerLevel = (dimmerLevel < 1.0) ? 1 : Math.round(dimmerLevel);

				var myJSONObject = {
					Header: {
						MessageBodyType: "OneZoneStatus",
						Bridge: this.bridgeID
					},
					Body: {
						ZoneStatus: {
							Level: dimmerLevel,
							Zone: {
								href: "/zone/" + this._lookupZoneByDeviceID(deviceID).toString()
							}
						}
					}
				};
				this._logger.debug('Sending: %o',myJSONObject);
				this._sendHubJSON(myJSONObject);
				return;
			}
			else if (msgline[i].indexOf('~DEVICE') !== -1) { // Pico or scene status update

				message = msgline[i].split(',');
				var picoDevice = message[1]; // note device 1 is always the bridge, hence a virtual button = scene
				var picoButtonNumber = message[2]; // if scene, this is the virtual button number
				var picoButtonOp = message[3]; // this will be 3 for press, 4 for release

				this._logger.info("Lutron Bridge %s, Device=%d, Button Code=%d Op=%d", this.bridgeID, picoDevice, picoButtonNumber, picoButtonOp);

				picoHandler.call(this, picoDevice, picoButtonNumber, picoButtonOp);

				this._logger.trace("%s active Pico buttons",Object.keys(picoActive).length);

				return;

				function picoHandler(picoDevice, picoButtonNumber, picoButtonOp) {
					var myPicoID = picoID(this.bridgeID, picoDevice, picoButtonNumber);
					var picoMode = this._buttonMode(picoDevice, picoButtonNumber);
					this._logger.trace('Pico button mode: %o', picoMode);

					if (picoDevice > BUTTON_VIRTUAL_DEVICEN)
						this._logger.info('Lutron Pico mode: %s', picoMode.rampHold ? 'push/repeat on hold' : 'push/hold');
					else
						this._logger.info('Lutron Scene: Virtual button %d', picoButtonNumber);

					if (picoButtonOp == BUTTON_OP_PRESS ||	// pressed
					    picoButtonOp == BUTTON_OP_HOLD  ||	// some keypads have an explicit Hold operation
					    picoButtonOp == BUTTON_OP_DBLTAP) { // some keypads have an explicit Double Tap operation
						var curPicoActive;
						// see if the corresponding button operation object already exists;
						//     if so, this must be repeated presses without intervening release (re-connect, maybe?)
						if (picoActive[myPicoID]) { // reuse the existing object for this pico button
							curPicoActive = picoActive[myPicoID];
							curPicoActive.restart();
						}
						else { // instantiate a new object for this active pico button
							curPicoActive = new PicoActive(this, picoDevice, picoButtonNumber,
							                               picoMode.forceRelease, picoMode.pushTime, picoMode.repeatTime);
							picoActive[myPicoID] = curPicoActive;
						}
						// listen for a release event on this button; note that an event is created per-button
						picoEvents.on(myPicoID, function(picoNextID, picoButtonNextOp, forcedrelease) {
							if (picoButtonNextOp == BUTTON_OP_RELEASE ||		// release
							    picoButtonNextOp == BUTTON_OP_HOLDRELEASE) {	// some keypads have explicit hold release
								var nextPicoActive = picoActive[picoNextID];
								nextPicoActive.timerQuash();
								var elapsed = nextPicoActive.elapsed();
								var textPushedHeld = (elapsed > nextPicoActive.pushTime ||
								                      picoButtonNextOp == BUTTON_OP_HOLDRELEASE) ? 'held' : 'pushed';
								this._logger.info('%s button was %sreleased in %d ms (%s)', picoNextID,
									(forcedrelease) ? 'force-' : '', elapsed, textPushedHeld);
								if (!nextPicoActive.wasRamped) {
									var myJSONObject = nextPicoActive.reportOp(textPushedHeld);
									nextPicoActive.bridge._sendHubJSON(myJSONObject);
								}
								var unelapsed = nextPicoActive.repeatTime - elapsed;
								if (unelapsed < 0)
									unelapsed = 0;
								// hopefully this debounce is long enough to avoid closed<->open races
								var timerContactDebounce = setTimeout(function() {
									if (this._picoDevice > BUTTON_VIRTUAL_DEVICEN) {
										var myJSONObject = this.reportOp('open');
										this.bridge._sendHubJSON(myJSONObject);
									}
									delete picoActive[this.picoID];
								}.bind(nextPicoActive), unelapsed);
							}
							else
								this._logger.warn('unexpected button event: %s %d', picoNextID, picoButtonNextOp);
						}.bind(this));
						var heldTimeout;
						switch (curPicoActive.forceRelease) {
							case BUTTON_FORCE.LONG_RELEASE:
								heldTimeout = PICO_HELD_TIMEOUT;
								break;
							case BUTTON_FORCE.HOLD_RELEASE:
								heldTimeout = curPicoActive.pushTime * 2;
								break;
							case BUTTON_FORCE.PRESS_RELEASE:
								heldTimeout = curPicoActive.pushTime / 2;
								break;
							case BUTTON_FORCE.NONE:
							default:
								heldTimeout = 0;
								break;
						}
						if (heldTimeout) {
							// if req'd prepare to force a button release after a specified timeout
							curPicoActive.timerRelease = setTimeout(function() {
								// can't count on a button release message, so simulate one
								picoEvents.emit(this.picoID, this.picoID, BUTTON_OP_RELEASE, true);
							}.bind(curPicoActive), heldTimeout);
						}
						if (picoMode.rampHold) { // ramp hold: start repeating held beyond 'short' press time
							curPicoActive.timerHeld = setTimeout(function() {
								this._logger.info('short-push timeout');
								this.intervalRamp = setInterval(function() {
									this.wasRamped = true;
									this._logger.info('ramp interval');
									var myJSONObject = this.reportOp('held');
									this.bridge._sendHubJSON(myJSONObject);
									return;
								}.bind(this), this.repeatTime);
							}.bind(curPicoActive), curPicoActive.pushTime);
						} // else long hold, just wait for a real (or forced) release
						// for real Picos, also send a press event to SmartThings in case it's interested
						if (picoDevice > BUTTON_VIRTUAL_DEVICEN) {
							var myJSONObject = curPicoActive.reportOp('closed');
							this._sendHubJSON(myJSONObject);
						}
					}
					else if (picoButtonOp == BUTTON_OP_RELEASE ||		// released
					         picoButtonOp == BUTTON_OP_HOLDRELEASE) {	// hold-released (some keypads only)
						picoEvents.emit(myPicoID, myPicoID, picoButtonOp, false);
					}
				}
			}
		}
	}.bind(this));

	this._telnetClient.on('error', function errorHandlerTelnet(err) {
		this._logger.error('Lutron Pro Bridge %s Telnet comm error %s %s', this.bridgeID, err.code, err);
		if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH' || err.code ===	'EPIPE') {
			// ... back off and retry connection
			var backoffms = (this._reconnectTries + 1) * LB_RECONNECT_DELAY_LONG;
			if (backoffms > LB_RECONNECT_DELAY_NORMMAX)
				backoffms = LB_RECONNECT_DELAY_NORMMAX;
			else
				this._reconnectTries++;
			this._reconnect(true, backoffms);
			return;
		}
		else if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
			// ... back off and restart connection from scratch
			this._reconnect(false, LB_RECONNECT_DELAY_AUTHFAIL);
			return;
		}
		else if (err.code !== undefined) { // who knows?!
			throw (err);
			return;
		}
		// geez who knows?? give up
		throw (err);
	}.bind(this));

	this._telnetClient.on('close', function() {
		this._telnetInSession = false;
		this._telnetClient = null;
		this._logger.error('Disconnected Telnet from Lutron Pro Bridge %s', this.bridgeID);
	}.bind(this));

	this._telnetClient.on('connect', function() {
		this._logger.info('Lutron Bridge %s confirming Telnet', this.bridgeID);
		// however, we aren't functionally connected until the first GNET> or QNET> prompt
	}.bind(this));

	this._telnetClient.connect(23, this.bridgeIP, function() {});

	this._telnetClient.setKeepAlive(true, 2000); // additionally, we'll ping once in a while to ensure re-connect

	function _telnetSessionConfirmed(telnetSessionConfirmedCallback) {
		this._telnetInSession = true;
		if (this._intervalTelnetRetryPending) {
			clearInterval(this._intervalTelnetRetryPending);
			this._intervalTelnetRetryPending = null;
		}
		this._logger.info('Lutron Bridge %s Telnet Connected!', this.bridgeID);

		if (this._intervalPing)
			clearInterval(this._intervalPing);
		this._expectPingback = false;
		this._intervalPing = setInterval(function() {
			if (this._telnetInSession && !this._expectPingback) {
				if (!this._expectResponse()) {
					this._logger.trace('Ping Bridge %s', this.bridgeID);
					process.stdout.write('                        \rPing ' + this.bridgeID + '... ');
					this._expectResponse(1);
					this._expectPingback = true;
					this._telnetClient.write('\r\n');	// don't log or force reconnect on ping
					// expected reply:
					// GNET> or QNET>
				}
				// else avoid stepping on expected status response w/ping
			// else either disconnect from Telnet or no ping response
			// force a diconnect if necessary, wait out the socket timeout or other comm error that should ensue
			} else if (this._telnetConnected()) {
				this._telnetInSession = false;
				this._telnetClient.destroy();
				this._telnetClient = null;
			}
		}.bind(this), LB_PING_INTERVAL);

		if (telnetSessionConfirmedCallback)
			telnetSessionConfirmedCallback();
	}
}
Bridge.prototype._buttonMode = function(buttonDevice, buttonNumber) { // lipID, Lutron native button code
	var buttonMode = {
		forceRelease: BUTTON_FORCE.NONE,
		rampHold: false,
		pushTime: PICO_PUSH_TIME_DEFAULT,
		repeatTime: PICO_REPEAT_TIME_DEFAULT
	};

	if (buttonDevice == BUTTON_VIRTUAL_DEVICEN) { // device 1 is the bridge, so this is a virtual button == scene
		buttonMode.forceRelease = BUTTON_FORCE.PRESS_RELEASE;
	} else {
		var aPico = this._picoList[buttonDevice];
		if (aPico) {
			var buttonIndex = buttonNumber;
			if (aPico.buttons.length == 1)		// index 0 is 'all' if that's all there is in the mode table
				buttonIndex = 0;
			if (aPico.buttons.length >= (Number(buttonIndex) + 1)) {
				buttonMode.forceRelease = aPico.buttons[buttonIndex].to6Sec ?
										  BUTTON_FORCE.LONG_RELEASE : BUTTON_FORCE.NONE;
				buttonMode.rampHold = (aPico.buttons[buttonIndex].mode == 'Press/Repeat');
				buttonMode.pushTime = aPico.pushTime;
				buttonMode.repeatTime = aPico.repeatTime;
			}
		}
	}
	return buttonMode;
}
Bridge.prototype._lookupDeviceIDByZone = function(deviceID, deviceZone) {
	if (!deviceID && deviceZone) { // if no device ID to use with telnet, reconstruct it from zone
		if (this._zoneList.device.length) {
			var dev = this._zoneList.device[deviceZone];
			deviceID = (dev && dev.ID) ? dev.ID : 0;
		}
        else
            deviceID = deviceZone;
	}
	return deviceID;
}
Bridge.prototype._lookupZoneByDeviceID = function(deviceID, deviceZone) {
	if (!deviceZone && deviceID) { // if no zone given, reconstruct it from device ID
		if (this._zoneList.device.length) {
			deviceZone = this._zoneList.device.findIndex(function(tzLD) {
				return (tzLD && (tzLD.ID == deviceID))
			}.bind(this));
			if (deviceZone <= 0)
				deviceZone = 0;
		}
		else
			deviceZone = deviceID;
	}
	return deviceZone;
}
Bridge.prototype._lookupZoneByName = function(zoneName) {
	var deviceZone;
	if (!isNaN(zoneName)) {
		deviceZone = Number(zoneName);
		if (deviceZone <= 0)
			deviceZone = 0; // zero is invalid/non-existent zone
	}
	else {
		var fqdn = zoneName.toString().split(':'); // either Name or Area:Name is ok
		fqdn = fqdn.filter(function(e) {
			return e;
		}.bind(this)); // ignore empty/null area or name
		var fqdnlen = fqdn.length;
		deviceZone = 0;
		if (fqdnlen >= 1) {
			if (this._zoneList.device.length) {
				deviceZone = this._zoneList.device.findIndex(function(tzLD) {
					return (tzLD &&
						(fqdn[fqdnlen - 1] === tzLD.Name) &&
						((fqdnlen < 2) || (fqdn[0] === tzLD.FullyQualifiedName[0])));
				}.bind(this));
			}
		}
		if (deviceZone <= 0)
			deviceZone = 0;
	}
	return deviceZone;
}

// bridge API methods
Bridge.prototype.initialize = function(authFunction, lbinitcallback) {	// lbinitcallback(initializeok)
	this._authorizer = authFunction;

	this._telnetErrorCallback = function (err) {
		var aError = new Error('Wrong authentication for this bridge');
		aError.code = 'ECONNREFUSED';
		lbinitcallback(aError);	// no authorization found, not successfully initialized
		return;
	}.bind(this);

	var telnetAuth = this._authorizer(this.bridgeType, this.bridgeID);
	if (!telnetAuth || !telnetAuth.login || !telnetAuth.password) {
		var aError = new Error('Cannot retrieve persistent authentication');
		aError.code = 'ENOENT';
		lbinitcallback(aError);	// no authorization found, not successfully initialized
		return;
	}
	this._telnetLogin = telnetAuth.login;
	this._telnetPassword = telnetAuth.password;

	this._reconnectTries = 0;
	// various requests to acquire the initial devices list and its ancillary data
	this._logger.info('Lutron Bridge %s initial devices request', this.bridgeID);
	var beIGDCbFn;
	this._bridgeEvents.on(BE_GOTDEVICES, beIGDCbFn = function beInitGotDevices( gdbridgeix, gdbupdated) {
		this._bridgeEvents.removeListener(BE_GOTDEVICES, beIGDCbFn);
		// once we've got all the devices' info...
		// set initial telnet login timeout and try to connect via telnet
		var timerTelnetInit = setTimeout(function lbTelnetInitTimeout() {
			this._logger.error('Lutron Bridge %s #%d Telnet isn\'t authorized or responding', this.bridgeID, this.bridgeIX);
			this._telnetErrorCallback(true);
		}.bind(this), LB_AUTH_TIMEOUT);
		this._logger.error('Lutron Bridge %s #%d Telnet Init (re-)trying', this.bridgeID, this.bridgeIX);
		this._telnetInit(bInitComplete.bind(this));
		return;

		function bInitComplete() {
			clearTimeout(timerTelnetInit);
			this.initialized = true;
			lbinitcallback(null);	// successfully initialized
		}
	}.bind(this));
//!!!!!	this is where we eventually try to determine the device list either by XML or other means
//!!!!! in the meantime, just create a bridge-only device list and fire the BE_GOTDEVICES event
	this._bridgeModel = 'Lutron Telnet';
	this._bridgeSN = this.bridgeID;
	this._allDevices[0] = {Bridge: this.bridgeID, DeviceType: 'LIPTelnet', FullyQualifiedName:[ this._bridgeModel], ID: 1,
                           ModelNumber: this._bridgeModel, Name: this._bridgeModel, SerialNumber: this._bridgeSN, href: '/device/1',
	                       NoDeviceList: true};

	this._bridgeEvents.emit(BE_GOTDEVICES, this.bridgeIX, this._updatedDevices); // we've got all the device info available; tell the listener(s)
//!!!!	if (autherr) {
//!!!!		lbinitcallback(autherr);	// no authorization found, not successfully initialized
//!!!!	}
}
Bridge.prototype.updateBridgeComm = function(lbridgeip) {
	if (lbridgeip) {
		this._logger.info('Lutron Bridge %s changed to IP=%s; reconnecting in %d seconds',
		                this.bridgeID, lbridgeip, LB_RECONNECT_DELAY_RESET / 1000);
		this.bridgeIP = lbridgeip;
		this._reconnectTries = 0;
		this._reconnect(false, LB_RECONNECT_DELAY_RESET);
	}
}
Bridge.prototype.disconnect = function() {
	if (this._telnetInSession) {
		this._telnetInSession = false;
		this._telnetClient.end('LOGOUT\r\n');
		this._telnetClient = null;
	}
}
Bridge.prototype.writeBridgeCommunique = function(msgBody, cb) {	// for comm format tests
	var error = null;
	if (!this.initialized) {
		error = new Error('Uninitialized bridge');
		error.code = 'ENOBRIDGE';
	}
	else if (typeof msgBody === 'string') {
		var firstChar = msgBody.charAt(0);
		if (this._telnetInSession && ('?~#'.indexOf(msgBody.charAt(0)) >= 0)) {
			this._telnetWrite(msgBody + '\r\n');
		}
		else
			error = new SyntaxError('Unknown Lutron Integration Profile Command (Telnet)');
	}
	if (typeof cb === 'function')
		cb(error);
}
Bridge.prototype.bridgeSummary = function() {
	var isConnected = this._telnetInSession;
	var summary = {};
	summary[this.bridgeID] = {
		Connected: isConnected,
		Ip: this.bridgeIP,
		BridgeBrand: this.bridgeBrand
	};
	if (isConnected) {
		summary[this.bridgeID].DeviceType = this._bridgeModel;
//!!!!		summary[this.bridgeID].Digest = (this._digestLeap + this._digestScenes);
	};
	return summary;
}
Bridge.prototype.deviceListRequest = function(dReqDeviceListIX, dReqDeviceListResetUpdated, dReqDeviceListCallback) {
	if (typeof dReqDeviceListCallback !== 'function')
		return;
	if (!this.initialized) {
		dReqDeviceListCallback(dReqDeviceListIX);	// uninitialized bridge, just return its default (empty) list
		return;
	}
	var	timerGetDeviceList;
	var handlerGetDeviceList = function hGDL(bIX) {
		clearTimeout(timerGetDeviceList);
		if (dReqDeviceListResetUpdated)
			this._updatedDevices = false;
		dReqDeviceListCallback(dReqDeviceListIX, this._allDevices);
		return;
	}.bind(this);
	timerGetDeviceList = setTimeout(function() {
		this._logger.warn('Lutron Bridge %s device list request timeout!', this.bridgeID);
		this._dReqDeviceListCallback.splice(this._dReqDeviceListCallback.indexOf(handlerGetDeviceList),1);
		handlerGetDeviceList(dReqDeviceListIX);
		return;
	}.bind(this), LB_REQUEST_TIMEOUT);

	this._dReqDeviceListCallback.push(handlerGetDeviceList);
//!!!! Here is where we could request the XML device list, but...
//	this._writeSSL(communiqueBridgeDevicesRequest);
//	this._expectResponse(1);
//!!!! ... in the meantime just return the static device list as-is
	if (this._dReqDeviceListCallback.length)
		this._dReqDeviceListCallback.shift()(dReqDeviceListIX);
}
Bridge.prototype.sceneListRequest = function(dReqSceneListIX, dReqSceneListResetUpdated, dReqSceneListCallback) {
	if (typeof dReqSceneListCallback !== 'function')
		return;
	if (!this.initialized) {
		dReqSceneListCallback(dReqSceneListIX);	// uninitialize bridge, just return its default (empty) list
		return;
	}
	var	timerGetSceneList;
	var handlerGetSceneList = function hGSL(bIX) {
		clearTimeout(timerGetSceneList);
		if (dReqSceneListResetUpdated)
			this._updatedScenes = false;
		dReqSceneListCallback(dReqSceneListIX, this._allScenes);
		return;
	}.bind(this);
	timerGetSceneList = setTimeout(function() {
		this._logger.warn('Lutron Bridge %s scene list request timeout!', this.bridgeID);
		this._dReqSceneListCallback.splice(this._dReqSceneListCallback.indexOf(handlerGetSceneList),1);
		handlerGetSceneList(dReqSceneListIX);
		return;
	}.bind(this), LB_REQUEST_TIMEOUT);
	this._dReqSceneListCallback.push(handlerGetSceneList);
	this._expectResponse(1);
//!!!! Here is where we could request the XML virtual button list, but...
//	this._writeSSL(communiqueBridgeScenesRequest);
//	this._expectResponse(1);
//!!!! ... in the meantime just return the static (empty) scene list as-is
	if (this._dReqSceneListCallback.length)
		this._dReqSceneListCallback.shift()(dReqSceneListIX);
}
Bridge.prototype.allZoneRefresh = function() {
	// there is really no good way to support this as there is no comprehensive zone list at this end
	this._zoneList.device.forEach(function(tzLD, tz) {
		this._leapRequestZoneLevel(tz);
	}.bind(this));
}
Bridge.prototype.sceneRequest = function(virtualButton, cb) {
	var error;
	// cannot ensure this is a valid scene number, so just send it along
	if (this._telnetInSession) {
		this._telnetWrite('#DEVICE,1,' + virtualButton + ',' +	BUTTON_OP_PRESS + '\r\n');
		//			this._telnetWrite('#DEVICE,1,' + virtualButton + ',' + BUTTON_OP_RELEASE + '\r\n');
		this._expectResponse(1);
	}
	error = 0; // accepted
//!!!! we might later want to intercept a ERROR message and return an error response...
//		error = new RangeError('No such scene'); // unknown scene
	if (typeof cb === 'function')
		cb(error);
}
Bridge.prototype.zoneStatusRequest = function(deviceZone, deviceID, cb) {

	if (this._telnetInSession) {
		// ST SmartApp may only send zone instead of both zone/device ID, for status inquiry
		deviceZone = this._lookupZoneByName(deviceZone);
		deviceID = this._lookupDeviceIDByZone(deviceID,deviceZone);
		if (deviceID) {
			this._telnetWrite('?OUTPUT,' + deviceID + ',' + LIP_CMD_OUTPUT_REQ +
				'\r\n');
			this._expectResponse(1);
			if (typeof cb === 'function')
				cb(0);
			return;
		} // else no device ID can be determined
	}
	if (typeof cb === 'function')
		cb(404); // unknown zone
}
Bridge.prototype.zoneSetLevelCommand = function(deviceZone, deviceID, deviceLevel, deviceFadeSec, cb) {

	this._logger.debug('Zone=%d dID=%d Level=%d Fade=%d',deviceZone, deviceID, deviceLevel, deviceFadeSec);
	if (this._telnetInSession) {
		deviceZone = this._lookupZoneByName(deviceZone);
		deviceID = this._lookupDeviceIDByZone(deviceID, deviceZone);
		if (deviceID) {
			this._telnetWrite('#OUTPUT,' + deviceID + ',' + LIP_CMD_OUTPUT_SET +
				',' +
				deviceLevel +
				(deviceFadeSec ? (',' + deviceFadeSec) : '') +
				'\r\n');
			this._expectResponse(1);
			if (typeof cb === 'function')
				cb(0);
			return;
		} // else no device ID can be determined
	}
	if (typeof cb === 'function')
		cb(404); // unknown zone
}
Bridge.prototype.zoneChangeLevelCommand = function(deviceZone, deviceID, deviceLevelCmd, cb) {
	var rlsMap = {
		raise: LIP_CMD_OUTPUT_RAISE,
		lower: LIP_CMD_OUTPUT_LOWER,
		stop: LIP_CMD_OUTPUT_STOP
	};

	var rlsCmd = rlsMap[deviceLevelCmd];
	if (!rlsCmd) {
		if (typeof cb === 'function')
			cb(400); // unknown command
		return;
	}
	if (this._telnetInSession) {
		deviceZone = this._lookupZoneByName(deviceZone);
		deviceID = this._lookupDeviceIDByZone(deviceID, deviceZone);
		if (deviceID) {
			this._telnetWrite('#OUTPUT,' + deviceID + ',' + rlsCmd + '\r\n');
			this._expectResponse(1);
			if (typeof cb === 'function')
				cb(0);
			return;
		} // else no device ID can be determined
	}
	if (typeof cb === 'function')
		cb(404); // unknown zone or command
}
Bridge.prototype.buttonRemoteAction = function(deviceSN, buttonNumber, action, cb) {
	var error;
	// cannot ensure this is a valid Pico/button number, so just send it along
	var piconameix = -1;
	if (deviceSN && buttonNumber && action) {
		var lipID = Number(deviceSN);
		var picoAction = 0;
		var picoHoldTime = 0;
		var picoMode = this._buttonMode(lipID, buttonNumber);
		switch (action) {
			case 'closed':
				picoHoldTime = 0;
				picoAction = BUTTON_OP_PRESS;
				break;
			case 'pushed':
				picoHoldTime = (picoMode.pushTime ? picoMode.pushTime : PICO_PUSH_TIME_DEFAULT) / 2;
				picoAction = BUTTON_OP_PRESS;
				break;
			case 'held':
				picoHoldTime = (picoMode.pushTime ? picoMode.pushTime : PICO_PUSH_TIME_DEFAULT) * 2;
				picoAction = BUTTON_OP_PRESS;
				break;
			case 'open':
				picoHoldTime = 0;
				picoAction = BUTTON_OP_RELEASE;
				break;
		}
		if (picoAction) {
			if (this._telnetInSession) {
				this._telnetWrite('#DEVICE,' + lipID + ',' + buttonNumber + ',' +	picoAction + '\r\n');
				this._expectResponse(1);
				if (picoHoldTime) {
					var picoHoldTimer = setTimeout(function(pLipID, pButtonNumber) {
						this._telnetWrite('#DEVICE,' + pLipID + ',' + pButtonNumber + ',' + BUTTON_OP_RELEASE + '\r\n');
						this._expectResponse(1);
					}.bind(this, lipID, buttonNumber), picoHoldTime);
				}
			}
			error = 0; // accepted
		}
		else
			error = new RangeError('No such Pico or action');
	}
	else
		error = new RangeError('No such Pico or button');
	if (typeof cb === 'function')
		cb(error);
}
Bridge.prototype.buttonRemoteSetMode = function(deviceSN, picoModeMap, picoPushTime, picoRepeatTime, cb) {
	var error;
	// cannot ensure this is a valid Pico number with this bridge type, so just save the info
	if (deviceSN && !this._picoList[deviceSN])	// deviceSN equivalent to lipID/deviceID in this kind of bridge
		this._picoList[deviceSN] = { buttons:[] };
	var aPico = this._picoList[deviceSN];
	if (deviceSN && aPico && picoModeMap) {
		var lipArray = [];
		for (var lipB in picoModeMap) {	// transform remote map to sparse array by LIP button #
			lipArray[Number(lipB)] = picoModeMap[lipB];
		}
		aPico.buttons = lipArray;
		aPico.pushTime = (picoPushTime ? picoPushTime : PICO_PUSH_TIME_DEFAULT);
		aPico.repeatTime = (picoRepeatTime ? picoRepeatTime : PICO_REPEAT_TIME_DEFAULT);

		this._logger.debug('Pico %s = %o', deviceSN, aPico);

		error = 0; // accepted
	}
	else
		error = new RangeError('No such Pico or no mode map');
	if (typeof cb === 'function')
		cb(error);
}


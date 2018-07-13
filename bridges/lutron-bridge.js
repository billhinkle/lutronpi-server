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
// v 1.1.0  lutronpro (original)		nate schwartz (github njscwartz)  with ICS license
// v 2.0.0+ lutronpi (forked)			wjh Bill hinkle (github billhinkle)
// v 2.0.0	2018.05.10 1200Z			wjh  Bill Hinkle (github billhinkle)
//	refactored into separate modules for supervisor, discovery, and bridge functions
//  see lutronpi.js supervisory module for additional/initial 2.0.0 revision list
// v 2.0.0-beta.2	2018.05.18 0400Z	wjh  Bill Hinkle (github billhinkle)
//					stretched request and response timeouts;
//					changed logger from module to per-bridge; const'd some constants
// v 2.0.0-beta.3	2018.07.13 2030Z	wjh  Bill Hinkle (github billhinkle)
//					corrected handling of null telnet connection upon bridge SSL reconnect
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
const BE_GOTBUTTONGROUPS = 'gotbuttongroups';
const BE_GOTSCENES = 'gotscenes';
const BE_GOTZLEVEL = 'gotzlevel'; // append bridge:zone indices

const communiqueBridgePingRequest =
	'{"CommuniqueType":"ReadRequest","Header":{"Url":"/server/status/ping"}}\n';
const communiqueBridgeServersRequest =
	'{"CommuniqueType":"ReadRequest","Header":{"Url":"/server"}}\n';
const communiqueBridgeDevicesRequest =
	'{"CommuniqueType":"ReadRequest","Header":{"Url":"/device"}}\n';
const communiqueBridgeScenesRequest =
	'{"CommuniqueType":"ReadRequest","Header":{"Url":"/virtualbutton"}}\n';
const communiqueBridgeButtonGroupsRequest =
	'{"CommuniqueType":"ReadRequest","Header":{"Url":"/buttongroup"}}\n';
const communiqueBridgeButtonsRequest =
	'{"CommuniqueType":"ReadRequest","Header":{"Url":"/button"}}\n';
const communiqueBridgeButtonProgrammingModelRequest1of2 =
	'{"CommuniqueType":"ReadRequest","Header":{"Url":"/programmingmodel/';
const communiqueBridgeButtonProgrammingModelRequest2of2 = '"}}\n';
const communiqueBridgeLIPDevicesRequest1of2 =
	'{"CommuniqueType":"ReadRequest","Header":{"Url":"' // LIP Server ID href
const communiqueBridgeLIPDevicesRequest2of2 = '"}}\n';
const communiqueBridgeZoneLevelRequest1of2 =
	'{"CommuniqueType":"ReadRequest","Header":{"Url":"/zone/'; // + zone # +
const communiqueBridgeZoneLevelRequest2of2 = '/status"}}\n';
const communiqueBridgeServerEnable1of3 =
	'{"CommuniqueType":"UpdateRequest","Header":{"Url":"'; // /server/2 for LIP
const communiqueBridgeServerEnable2of3 =
	'"},"Body":{"Server":{"href":"';						// /server/2 for LIP
const communiqueBridgeServerEnable3of3 =
	'","EnableState":"Enabled"}}}\n';
const communiqueBridgeZoneLevel1of4 =
	'{"CommuniqueType":"CreateRequest","Header":{"Url":"/zone/'; //  + zone # +
const communiqueBridgeZoneLevel2of4 =
	'/commandprocessor"},"Body":{"Command":{"CommandType":';
const communiqueBridgeZoneLevelSet3of4 =
	'"GoToLevel","Parameter":[{"Type":"Level","Value":'; // + level % +
const communiqueBridgeZoneLevelSet4of4 = '}]}}}\n';
const communiqueBridgeZoneLevelRaise3of4 = '"Raise"';
const communiqueBridgeZoneLevelLower3of4 = '"Lower"';
const communiqueBridgeZoneLevelStop3of4 = '"Stop"';
const communiqueBridgeZoneLevelRLS4of4 = '}}}\n';
// n.b. for shades, MAYBE 3of4: '"ShadeLimitRaise/Lower","Parameter":[{"Type":"Type":"Action","Value":"Start/Stop"}]'
const communiqueBridgeVirtualButtonPress1of2 =
	'{"CommuniqueType": "CreateRequest","Header": {"Url":"/virtualbutton/'; // + virtual button # +
const communiqueBridgeVirtualButtonPress2of2 =
	'/commandprocessor"},"Body": {"Command": {"CommandType": "PressAndRelease"}}}\n';
const communiqueBridgePicoButtonAction1of3 =
	'{"CommuniqueType": "CreateRequest","Header": {"Url":"/button/'; // + pico button # from pico's buttongroup +
const communiqueBridgePicoButtonAction2of3 =
	'/commandprocessor"},"Body": {"Command": {"CommandType": ';
const communiqueBridgePicoButtonActionPressAndRelease3of3 =
	'"PressAndRelease"}}}\n';
const communiqueBridgePicoButtonActionPressAndHold3of3 = '"PressAndHold"}}}\n';
const communiqueBridgePicoButtonActionRelease3of3 = '"Release"}}}\n';

const LB_REQUEST_TIMEOUT = 5000;	// was 1500
const LB_RESPONSE_TIMEOUT = 20000;	// was 3000
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

// match Lutron LIP to LEAP devices and inject LIP device IDs into LEAP device list
function parseLip2Leap(lipData, leapData, logger) {
	if (!logger)
		var logger = log;
	var lipComplete = [];
	// Make the Devices (Picos... shades too?) and Zones (Lighting) objects a single array
	for (var i = 0; i < lipData.Devices.length; i++) {
		lipComplete.push(lipData.Devices[i]);
	}
	if (lipData.Zones) {
		for (var i = 0; i < lipData.Zones.length; i++) {
			lipComplete.push(lipData.Zones[i]);
		}
	}
	var idMismatches = 0;
	var idUnmatched = lipComplete.length;
	// Add the LIP ID to the LEAP data, matching by device name and area, if available
	for (var i in lipComplete) {
		logger.debug("Matching LIP: ", lipComplete[i].Name);
		for (var j in leapData) {
			logger.trace(leapData[j].Name);
			if (leapData[j].ID === undefined &&
				lipComplete[i].Name == leapData[j].Name &&
				(lipComplete[i].Area === undefined ||
					(leapData[j].FullyQualifiedName.length > 1 &&
						lipComplete[i].Area.Name == leapData[j].FullyQualifiedName[0]))) {

				logger.debug("Matched LEAP name to LIP ID: ", lipComplete[i].ID);
				leapData[j]["ID"] = lipComplete[i].ID;
				idUnmatched--;
				if (leapData[j].ID != Number(leapData[j].href.replace(/\/device\//i, ''))) { // '/device/xxx'
					logger.debug("Device %s ID mismatch", leapData[j].FullyQualifiedName);
					idMismatches++;
				}
			}
		}
		logger.trace(leapData);
	}
	// Check if there is a discrepancy between LEAP and LIP ID's and notify the user if there is
	if (idUnmatched)
		logger.info(
			"%d devices from LIP server do not match anything from LEAP server! This might cause problems for you.",
			idUnmatched);
	if (idMismatches)
		logger.info(
			"%d device ID(s) for LEAP and LIP servers do not match! This might cause problems for you.",
			idMismatches);
}

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

// object representing Lutron Caseta or RA2/Select bridge
function Bridge( lbridgeix, lbridgeid, lbridgeip, sendHubJSON, sentHubEvents ) {
	this.bridgeIX = lbridgeix;
	this.bridgeBrand = 'Lutron';
	this.bridgeType = 'lutron';
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
	this._pro = false;
	this._lipServerIDHref;
	this._sslClient = null;
	this._sslSession = null;
	this._sslErrorCallback = null;
	this._sslBufferedData = '';

	this._telnetClient = null;
	this._telnetIsConnect = false;

	this._allDevices = null;
	this._allScenes = null;
	this._picoList = {}; // map Pico SN to leap device, lip ID, button details & mode (sent from SmartThings)
	this._zoneList = {
		device: [],
		isShade: []
	} // map lighting/shade zones to device and type lighting vs shade

	this._expectedResponseCnt = 0;
	this._expectPingback = false;
	this._flipPingTag = false;
	this._intervalPing = null;
	this._timerResponse = null;
	this._timerBackoff = null;
	this._intervalTelnetRetryPending = null;
	this._intervalBridgePoll = null;
	this._expectPollDevices = false;
	this._expectPollScenes = false;
	this._digestLeap = '';
	this._digestScenes = '';
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
	this._options = {};		// command-line options, including nopro flag to ignore Pro-ness of this bridge
	let opttag = this.bridgeID + '=';
	for (let a=2; a < process.argv.length; a++) {
		if (process.argv[a].startsWith(opttag)) {
			let opt = process.argv[a].substr(opttag.length).toLowerCase();
			this._options[opt] = true;
		}
	}

	// set option higher-detail logging per CLI optiosn trace/debug
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
Bridge.prototype._setPingSSL = function() {
	// send an occasional ping to ensure we're still connected to the bridge
	// if a telnet connection is made to a Pro bridge, that will assume ping handling
	if (this._intervalPing)
		clearInterval(this._intervalPing);
	this._expectPingback = false;
	this._intervalPing = setInterval(function() {
		if (!this._expectPingback && !this._expectResponse()) {
			process.stdout.write('                        \rPing ' + this.bridgeID + '... ');
			this._expectResponse(1);
			this._expectPingback = true;
			this._writeSSL(communiqueBridgePingRequest);
			// expected reply:
			// {"CommuniqueType":"ReadResponse","Header":{"MessageBodyType":"OnePingResponse","StatusCode":"200 OK","Url":"/server/status/ping"},"Body":{"PingResponse":{"LEAPVersion":1.106}}}
		}
		// else     we didn't get a ping response! OR avoid stepping on expected status response w/ping
		// defer further pings and wait out the socket timeout or other comm error that should ensue
	}.bind(this), LB_PING_INTERVAL);
}
Bridge.prototype._sslConnected = function() {
	return (!!this._sslClient && !this._sslClient.destroyed);
}
Bridge.prototype._connectSSL = function(resume, cbonconnect) {	// returns error if authentication fails, else null
	var options = {};

	this._expectResponse(false); // disable expected response monitor
	this._expectPollDevices = false;
	this._expectPollScenes = false;

	resume &= (this._sslSession != null);
	if (resume) { // resume half-closed session
		options = {
			session: this._sslSession,
			rejectUnauthorized: false
		};
	}
	else { // new session -- we may need to try multiple certs/keys until we hit the right one for this bridge
		var lutronAuth = this._authorizer(this.bridgeType, this.bridgeID);
		if (!lutronAuth) {
			var aError = new Error('Cannot retrieve persistent authentication');
			aError.code = 'ENOENT';
			return aError ;
		}
		options = {
			key: Buffer.from(lutronAuth.privateKey.data?lutronAuth.privateKey.data:lutronAuth.privateKey),
			cert: lutronAuth.appCert,
			ca: lutronAuth.localCert,
			rejectUnauthorized: false,
			//	   allowHalfOpen: true,	// allow other end to FIN w/o closing socket for writes
		};
		this._sslSession = null;
	}
	this._sslClient = tls.connect(8081, this.bridgeIP, options, function lbConnected() {
		this._logger.info("Lutron Bridge %s SSL %sconnected at " + (new Date()), this.bridgeID, (resume) ? "re-" : "");

		this._sslClient.on('end', function() {
			this._logger.warn("Lutron Bridge %s disconnected itself", this.bridgeID);
			// session is resumable if no error, so let it go for now
		}.bind(this));

		this._sslClient.on('close', function(erred) {
			this._logger.info("Lutron Bridge %s comm closed %s", this.bridgeID, (erred) ? "with error" : "normally");
			// session is resumable if no error, so let it go for now
		}.bind(this));

		if (!resume) { // just turning on keep-alive didn't forestall half-disconnects, so... resume instead
			this._sslSession = Buffer.from(this._sslClient.getSession()); // save this for resumes afte FIN
		}

		this._listenSSL(this._handleIncomingSSLData.bind(this));

		if (!this._telnetIsConnect)
			this._setPingSSL();

		if (typeof cbonconnect === "function")
			cbonconnect(resume);
	}.bind(this));
	this._setErrorHandlerSSL();
	return null;	// authentication retrieved, whether valid or not
}
Bridge.prototype._reconnect = function(attemptresume, backoffms) {
	if (this._sslConnected()) {
		this._sslClient.destroy();
	}
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
		this._connectSSL(attemptresume, function lbReconnected(resumed) {
			if (this._telnetClient !== null)
				this._telnetClient.destroy();
			this._telnetIsConnect = false;
			this._telnetClient = null;
			if (this._pro)
				this._initTelnet();
		}.bind(this));
	}.bind(this), backoffms);
}
Bridge.prototype._setErrorHandlerSSL = function() {
	this._sslClient.on('error', function errorHandlerSSL(err) {
		this._logger.error('Lutron Bridge %s SSL comm error %s %s', this.bridgeID, err.code, err);
		if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH') {
			// ... back off and retry connection
			var backoffms = (this._reconnectTries + 1) * LB_RECONNECT_DELAY_LONG;
			if (backoffms > LB_RECONNECT_DELAY_NORMMAX)
				backoffms = LB_RECONNECT_DELAY_NORMMAX;
			else
				this._reconnectTries++;
			this._reconnect(true, backoffms);
		}
		else if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EPROTO') {
			// if bad cert on session resume, try once more from scratch
			if (this._sslSession)
				this._reconnect(false, LB_RECONNECT_DELAY_AUTHFAIL);
			else {
				// ... back off and restart connection from scratch
				if (this._sslErrorCallback)
					this._sslErrorCallback(err);
				else
					this._reconnect(false, LB_RECONNECT_DELAY_AUTHFAIL);
			}
		}
		else if (err.code !== undefined) { // likely not an SSL error, give up
			throw (err);
			return;
		}
		else { // likely an SSL error following an ECONNRESET etc.
			// if it's a bad certificate, just informational
			if (err.message.indexOf('bad certificate') != -1 ||
				err.message.indexOf('SSL alert number 42') != -1) {
				this._logger.warn('Lutron Bridge %s #%d refused this authentication!', this.bridgeID, this.bridgeIP);
				return;
			}
			// otherwise let it go for now, maybe it's ok
		}
	}.bind(this));
}
Bridge.prototype._writeSSL = function(data) {
	if (!this._sslConnected()) {
		this._connectSSL(true, function lbResumeSessionOnWrite(resumed) {
			this._sslClient.write(data);
		}.bind(this));
	}
	else
		this._sslClient.write(data);
}
Bridge.prototype._listenSSL = function(msgcallback) {
	this._sslClient.on('data', function lbIncomingData(data) {
		this._logger.trace('data in listenSSL:',data);
		this._sslBufferedData += data;
		try {
			var bufferedString = this._sslBufferedData.toString().trim();
			JSON.parse(bufferedString);
			var digest = (crc32.str(bufferedString) >>> 0).toString(16);

			this._logger.trace('Buffered data is proper JSON');
			this._logger.trace(bufferedString);

			this._sslBufferedData = '';
		} catch (e) {
			if (e instanceof SyntaxError &&
			   (e.message.startsWith('Unexpected end of JSON input') || e.message.startsWith('Unexpected token'))) {
				this._logger.debug('.'); // ('json not valid, probably don\'t have it all yet');
			}
			else {
				this._logger.error("Exception at SSL listener, Error: ", e);
				throw (e);
			}
			return;
		}
		msgcallback(bufferedString, digest);
		return;
	}.bind(this));
}
Bridge.prototype._handleIncomingSSLData = function (msgStringData, digest) {
	var jsonData = JSON.parse(msgStringData);

	if (jsonData.Header.MessageBodyType == 'OnePingResponse') {
		this._expectResponse(-1);
		this._expectPingback = false;
		this._flipPingTag = !this._flipPingTag;
		process.stdout.write('Pinged Bridge ' + this.bridgeID + ' ' + (this._flipPingTag ?	'S' : 's') + '\r');
		return;
	}

	this._logger.debug('Incoming SSL is proper JSON; len=%d digest=%s', msgStringData.length,	digest);

	if (jsonData.Header.MessageBodyType == 'MultipleServerDefinition') { // Bridge server list received
		this._expectResponse(-1);

		this._logger.debug('Intra-bridge server list received');
		this._logger.debug(msgStringData);

		this._pro = false;
		var lipServer = jsonData.Body.Servers.find(function(s) {
			return (s.Type == 'LIP')
		}.bind(this));
		if (lipServer) {
			if (this._options.nopro) { // pretend Pro bridge is Std, no LIP, no Telnet
				this._logger.info('Lutron TEST Std Bridge %s', this.bridgeID);
			}
			else {
				this._logger.info('Lutron Pro/RA+ Bridge %s', this.bridgeID);
				if (lipServer.EnableState == 'Enabled') {
					this._pro = true;
					this._lipServerIDHref = lipServer.LIPProperties.Ids.href;
				}
				else {
					this._logger.warn('Lutron Bridge %s: app Settings/Advanced/Integration/Telnet is turned off!', this.bridgeID);
					this._writeSSL(
						communiqueBridgeServerEnable1of3 +  lipServer.href +
						communiqueBridgeServerEnable2of3 +  lipServer.href +
						communiqueBridgeServerEnable3of3
					);
					this._expectResponse(1);
					return;
				}
			}
		}
		else
			this._logger.info('Lutron Std Bridge %s', this.bridgeID);

		// now request and await the LEAP device list
		this._logger.info('Lutron Bridge %s LEAP request', this.bridgeID);
		this._writeSSL(communiqueBridgeDevicesRequest);
		this._expectResponse(1);
		return;
	}
	else if (jsonData.Header.MessageBodyType == 'OneServerDefinition') { // a single bridge server's info received
		this._expectResponse(-1);
		var aServer = jsonData.Body.Server;
		if (!aServer)
			return;

		this._logger.debug('Bridge %s server list received', aServer.Type);
		this._logger.debug(msgStringData);

		if (aServer.Type == 'LIP' && aServer.EnableState == 'Enabled') {
			this._pro = true;
			this._lipServerIDHref = aServer.LIPProperties.Ids.href;
			this._logger.info('Lutron Std Bridge %s', this.bridgeID);
			this._logger.warn('Lutron Bridge %s: app Settings/Advanced/Integration/Telnet has been turned on!', this.bridgeID);
		}

		// now request and await the LEAP device list
		this._logger.info('Lutron Bridge %s LEAP request', this.bridgeID);
		this._writeSSL(communiqueBridgeDevicesRequest);
		this._expectResponse(1);
		return;
	}
	else if (jsonData.Header.MessageBodyType == 'MultipleDeviceDefinition') { // LEAP device list received
		this._expectResponse(-1);
		this._logger.debug('LEAP Data was received ' +
					    (this._expectPollDevices ? 'for poll' : 'and sent to parser'));

		if (digest != this._digestLeap) {
			this._digestLeap = digest;
			this._updatedDevices = true;
			this._logger.info('Lutron Bridge %s Devices (LEAP) data has changed since last request', this.bridgeID);
		}

		if (this._expectPollDevices) {
			this._expectPollDevices = false;
			return; // don't update our internal map of the devices, just note its digest hash
		}
		else
			this._pollBridge(); // reset the next poll out from this response

		this._logger.debug(msgStringData);

		this._allDevices = jsonData.Body.Devices;

		// identify the bridge itself
		var bridgeDevice = this._allDevices.find(function(lD) {
				return (lD.href == '/device/1');
			}.bind(this));
		this._bridgeModel = bridgeDevice.ModelNumber;
		this._bridgeSN = bridgeDevice.SerialNumber;

		if (!this.bridgeID)	// if we weren't passed a bridge ID (e.g. not discovered) then make it from the SN
			this.bridgeID = (this._bridgeSN >>> 0).toString(16).padStart(8,'0').toUpperCase();

		// do some per-device bookkeeping
		for (var j in this._allDevices) {
			// attach bridge ID to each device so we can tell them apart in requests
			this._allDevices[j].Bridge = this.bridgeID;
			if (!this._pro) { //  for non-PRO/RA bridges, attach an initial ID to each device based on its /device/ii property
				try {
					this._allDevices[j].ID = Number(this._allDevices[j].href.replace(
						/\/device\//i, ''));
				}
				catch (e) {}
			}
			// ** perform any DeviceType remapping here ** e.g.
			// if (this._allDevices[j].DeviceType == 'WallDimmer')
			//	this._allDevices[j].DeviceType = 'SomeKindaShade';

			// build zone-to-device/type mapping list
			for (var z in this._allDevices[j].LocalZones) {
				var aZone = Number(this._allDevices[j].LocalZones[z].href.replace(
					/\/zone\//i, ''));
				this._zoneList.device[aZone] = this._allDevices[j];
				this._zoneList.isShade[aZone] = this._allDevices[j].DeviceType.endsWith(
					'Shade');
			}
		}
		this._logger.info('Lutron Bridge %s Zone info :\n%o\n', this.bridgeID, this._zoneList);

		if (this._pro) {
			// request the LIP device data, only available on the Pro and RA2 Select bridges
			this._logger.info('Lutron Bridge %s LIP request', this.bridgeID);
			this._writeSSL(communiqueBridgeLIPDevicesRequest1of2 + this._lipServerIDHref +
				communiqueBridgeLIPDevicesRequest2of2);
			this._expectResponse(1);
		}
		else { // we've got all the device info available; obtain button details before we tell the listener(s)
			this._logger.info('Lutron Bridge %s LEAP Device info:\n%o\n', this.bridgeID, this._allDevices);

			// now request and await the button groups list
			this._logger.info('Lutron Bridge %s button groups request', this.bridgeID);
			this._writeSSL(communiqueBridgeButtonGroupsRequest);
			this._expectResponse(1);
		}
		return;
	}
	else if (jsonData.Header.MessageBodyType == 'OneLIPIdListDefinition') { // LIP device list received
		this._expectResponse(-1);
		this._logger.debug('LIP Data was received and sent to parser');
		this._logger.debug(msgStringData);

		// update LEAP data w/ LIP IDs in-place - no need to retain LIP list
		parseLip2Leap(jsonData.Body.LIPIdList, this._allDevices, this._logger);
		this._logger.info('Lutron Bridge %s merged LEAP/LIP Device info:\n%o\n', this.bridgeID, this._allDevices);

		// now request and await the button groups list
		this._logger.info('Lutron Bridge %s button groups request', this.bridgeID);
		this._writeSSL(communiqueBridgeButtonGroupsRequest);
		this._expectResponse(1);
	}
	else if (jsonData.Header.MessageBodyType == 'MultipleButtonGroupDefinition') {
		this._expectResponse(-1);
		this._logger.debug('Button Group Data was received and sent to parser');

		this._logger.debug(msgStringData);

		var bgroups = jsonData.Body.ButtonGroups;
		for (var i = 0; i < bgroups.length; i++) {
			var leapPico = this._allDevices.find(function(lD) {
				return (lD.href == bgroups[i].Parent.href);
			}.bind(this));
			if (leapPico) {
				this._picoList[leapPico.SerialNumber] = {
					href: leapPico.href,
					hrefButtonGroup: bgroups[i].href, // Number(bgroups[i].href.replace( /\/buttongroup\//i, '')),
					ID: leapPico.ID,
					leapBNOffset: 100,
					leapButtons: [],
					leapBProgModels: [],
					leapBPressAndHoldOK: []
				};
				// set/update leap button # but do not overwrite mode info sent from ST!
				if (!this._picoList[leapPico.SerialNumber].buttons)
					this._picoList[leapPico.SerialNumber].buttons = [];
				// other buttongroup properties are...
				// "SortOrder":0,"StopIfMoving":"Disabled","Category":{"Type":"Lights"},"ProgrammingType":"Column"
			}
		}
		// now request and await the button definitions list
		this._logger.info('Lutron Bridge %s button definitions request', this.bridgeID);
		this._writeSSL(communiqueBridgeButtonsRequest); // now get the specific buttons info
		this._expectResponse(1);
		return;
	}
	else if (jsonData.Header.MessageBodyType == 'MultipleButtonDefinition') {
		this._expectResponse(-1);
		this._logger.debug('Button Data was received and sent to parser');

		this._logger.debug(msgStringData);

		var buttons = jsonData.Body.Buttons;
		for (var i = 0; i < buttons.length; i++) {

			var aPico = this._picoList[Object.keys(this._picoList).find(function(k) {
					return (this._picoList[k].hrefButtonGroup == buttons[i].Parent.href)
				}.bind(this))];
			if (aPico) {
				var bNumber = buttons[i].ButtonNumber;
				if (bNumber < aPico.leapBNOffset)
					aPico.leapBNOffset = bNumber;

				aPico.leapButtons[bNumber] = Number(buttons[i].href.replace(/\/button\//i,''));
				aPico.leapBProgModels[bNumber] = Number(buttons[i].ProgrammingModel.href.replace(/\/programmingmodel\//i, ''));

				// now get each button's specific press-vs-hold permissions
				// now request and await the button groups list
				this._logger.debug('Lutron Bridge %s programming model %d request', this.bridgeID, aPico.leapBProgModels[bNumber]);
				this._writeSSL(communiqueBridgeButtonProgrammingModelRequest1of2 +
				               aPico.leapBProgModels[bNumber] +
				               communiqueBridgeButtonProgrammingModelRequest2of2);
				this._expectResponse(1);
			}
		}
		// update the buttons table from SmartThings device handlers to add LIP button number (2-6, 8-11) and press/hold mode

		this._logger.info('Lutron Bridge %s Pico info:\n%o\n', this.bridgeID, this._picoList);
		this._bridgeEvents.emit(BE_GOTBUTTONGROUPS, this.bridgeIX);
		this._bridgeEvents.emit(BE_GOTDEVICES, this.bridgeIX, this._updatedDevices); // we've got all the device info available; tell the listener(s)

		if (this._dReqDeviceListCallback.length)
			this._dReqDeviceListCallback.shift()(this.bridgeIX);
		return;
	}
	else if (jsonData.Header.MessageBodyType == 'OneProgrammingModelDefinition') {
		this._expectResponse(-1);
		this._logger.debug('Button programming model Data was received and sent to parser');

		this._logger.debug(msgStringData);

		var aPico = this._picoList[Object.keys(this._picoList).find(function(k) {
				return (undefined != this._picoList[k].leapBProgModels.find(function(lBPM) {
					return (lBPM == Number(jsonData.Header.Url.replace(/\/programmingmodel\//i, '')));
				}.bind(this)));
			}.bind(this))];
		if (aPico) {
			bNumber = aPico.leapBProgModels.findIndex(function(lBPM) {
				return (lBPM == Number(jsonData.Header.Url.replace(/\/programmingmodel\//i, '')));
			}.bind(this));
			aPico.leapBPressAndHoldOK[bNumber] =
				(jsonData.Body.ProgrammingModel.ProgrammingModelType !=	'SingleActionProgrammingModel');
			this._logger.debug('ProgModel %d for bNumber %d is %s', aPico.leapBProgModels[
				bNumber], bNumber, jsonData.Body.ProgrammingModel.ProgrammingModelType);
		}
		return;
	}
	else if (jsonData.Header.MessageBodyType == 'MultipleVirtualButtonDefinition') {
		this._expectResponse(-1);
		this._logger.debug('Scenes Data was received ' +
						(this._expectPollScenes ? 'for poll' : 'and sent to parser'));

		if (digest != this._digestScenes) {
			this._digestScenes = digest;
			this._updatedScenes = true;
			this._logger.info('Lutron Bridge %s Scene data has changed since last request', this.bridgeID);
		}

		if (this._expectPollScenes) {
			this._expectPollScenes = false;
			return; // don't update our internal map of the scenes, just note its digest hash
		}
		this._logger.debug(msgStringData);

		var buttons = jsonData.Body.VirtualButtons;
		var tempList = [];
		var j;
		for (var i = 0; i < buttons.length; i++) {
			if (buttons[i].IsProgrammed == true) {
				//			tempList[tempList.push(buttons[i])-1].Bridge = this.bridgeID;
				j = tempList.push(( ({href,Name}) => ({href,Name}) )(buttons[i])) - 1;
				tempList[j].Bridge = this.bridgeID;
				tempList[j].Scene = Number(buttons[i].href.replace(/\/virtualbutton\//i,''));
			}
		}
		this._allScenes = tempList;
		this._logger.info('Lutron Bridge %s Scene info:\n%o\n', this.bridgeID, this._allScenes);

		this._bridgeEvents.emit(BE_GOTSCENES, this.bridgeIX, this._updatedScenes);
		if (this._dReqSceneListCallback.length)
			this._dReqSceneListCallback.shift()(this.bridgeIX);
		return;
	}
	else if (jsonData.Header.MessageBodyType == 'OneZoneStatus') {
		jsonData.Header.Bridge = this.bridgeID;
		var aZone = jsonData.Body.ZoneStatus.Zone.href.replace(/\/zone\//i, '');
		this._logger.info('Zone Status Received, Lutron Bridge %s Zone %d to %d\%',this.bridgeID,
		               aZone,jsonData.Body.ZoneStatus.Level);
		this._logger.debug(msgStringData);

		var levelRequested = (jsonData.Header.Url == (jsonData.Body.ZoneStatus.Zone.href + '\/status') ||
		                      jsonData.Header.Url == (jsonData.Body.ZoneStatus.Zone.href + '\/commandprocessor')); // + '/level' if not requested
		if (levelRequested)
			this._expectResponse(-1);

		var eventZLName = eventZoneLevel(this.bridgeID, aZone);
		if (this._bridgeEvents.listenerCount(eventZLName)) {
			this._logger.info('Refresh Lutron %s Bridge %s Zone %d status sent to ST hub',
						   (this._pro) ?	'Pro' : 'Std', this.bridgeID, aZone);
			this._bridgeEvents.emit(eventZLName, jsonData);
			return;
		}

		if ((levelRequested || !this._telnetIsConnect)) {
			this._logger.info('Lutron %s Bridge %s Zone %d status sent to ST hub',
						   (this._pro) ? 'Pro' : 'Std', this.bridgeID, aZone);
			this._sendHubJSON(jsonData); // unsolicited zone level updates from Pro bridge handled via Telnet
		}
		return;
	}
	else if (jsonData.Header.StatusCode == '204 NoContent' ||
	         jsonData.Header.StatusCode == '201 Created') { // probably a command acknowledgement
		this._logger.debug(msgStringData);
		this._expectResponse(-1);
		return;
	}
	else if (jsonData.CommuniqueType == 'ExceptionResponse') { // some kind of bad command to Lutron: report it
		this._logger.error('Lutron Comm Error: %o', jsonData);
		this._logger.debug(msgStringData);
		this._expectResponse(0); // reset response expectations: who knows what's going on at thsi point?!
		return;
	}
	else { // some other response; just note it for future reference
		this._logger.warn('SSL data from Lutron %s Bridge %s ignored', (this._pro) ? "Pro" : "Std", this.bridgeID);
		this._logger.warn(msgStringData);
		return;
	}
}
Bridge.prototype._pollBridge = function() {
	// occasionally poll the bridge for changes to devices and scenes
	if (this._intervalBridgePoll)
		clearInterval(this._intervalBridgePoll);
	this._intervalBridgePoll = setInterval(function() {
		if (!this._expectPollDevices) {
			this._logger.debug('Lutron Bridge %s #%d devices poll', this.bridgeID, this.bridgeIX);
			this._expectResponse(1);
			this._expectPollDevices = true;
			this._writeSSL(communiqueBridgeDevicesRequest);
			// expected reply: LEAP devices
		}
		if (!this._expectPollScenes) {
			this._logger.debug('Lutron Bridge %s #%d scenes poll', this.bridgeID, this.bridgeIX);
			this._expectResponse(1);
			this._expectPollScenes = true;
			this._writeSSL(communiqueBridgeScenesRequest);
			// expected reply: LEAP scenes
		}
	}.bind(this), LB_POLL_INTERVAL);
}
Bridge.prototype._initTelnet = function(telnetConnectCallback) {
	if (!this._telnetIsConnect) {
		this._logger.info('Starting Telnet connection to Lutron Bridge %s', this.bridgeID);
		this._telnetIsConnect = false;
		if (this._telnetClient !== null && !this._telnetClient.destroyed)
			this._telnetClient.destroy();
		this._telnetClient = new net.Socket();
		this._telnetHandler(telnetConnectCallback);
	}
}
Bridge.prototype._telnetHandler = function(telnetConnectCallback) {
	this._telnetClient.on('data', function(data) {
		var msgline;
		var message;

		this._logger.trace('Lutron Bridge %s Telnet received: Bridge %s', this.bridgeID, data);
		// we have to account for GNET> prompts embedded within responses, and multiple-line responses
		message = data.toString();
		if (message.indexOf('GNET>') !== -1) { // a prompt, but it might've been embedded so reprocess line also
			if (!this._telnetIsConnect) { // first prompt upon connection
				_telnetConnectConfirmed.call(this, telnetConnectCallback);
			}
			else { // likely a ping, note that we did get a ping response
				// currently taking a GNET> prompt as a ping response, but we COULD instead send
				// ?SYSTEM,10 and get back  ~SYSTEM,12/28/2017,14:40:06  e.g.
				this._expectResponse(-1);
				this._expectPingback = false;
				// visual Ping sugar only
				this._flipPingTag = !this._flipPingTag;
				process.stdout.write('Pinged Bridge ' + this.bridgeID + ' ' + (this._flipPingTag ?	'T' : 't') + '\r');
			}
			// now remove the prompt(s) and continue processing the data
			message = message.replace(/GNET\>\s/g, '');
		}
		msgline = message.match(/^.*((\r\n|\n|\r|\s)|$)/gm); // break up multiple & concatenated lines

		for (var i = 0, mlcnt = msgline.length; i < mlcnt; i++) {
			if (msgline[i].length)
				this._logger.debug('Lutron Bridge %s Telnet received: %s', this.bridgeID, msgline[i]);
			if (msgline[i].indexOf('login') !== -1) {
				this._telnetClient.write('lutron\r\n');
			}
			else if (msgline[i].indexOf('password') !== -1) {
				this._telnetClient.write('integration\r\n');
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

					if (picoButtonOp == BUTTON_OP_PRESS) { // pressed
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
							if (picoButtonNextOp == BUTTON_OP_RELEASE) { // released 
								var nextPicoActive = picoActive[picoNextID];
								nextPicoActive.timerQuash();
								var elapsed = nextPicoActive.elapsed();
								var textPushedHeld = (elapsed > nextPicoActive.pushTime) ? 'held' : 'pushed';
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
					else if (picoButtonOp == BUTTON_OP_RELEASE) { // released
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
			return
		}
		else if (err.code !== undefined) { // likely not an SSL error
			throw (err);
			return;
		}
		// geez who knows?? give up
		throw (err);
	}.bind(this));

	this._telnetClient.on('close', function() {
		this._telnetIsConnect = false;
		this._telnetClient = null;
		this._logger.error('Disconnected Telnet from Lutron Pro Bridge %s', this.bridgeID);
		if (this._sslConnected()) {
			// hand the pinging duties back to the SSL connection
			this._setPingSSL();
		}
		// but just in case someone turned off the Telnet Integration manually - try to reconnect every few minutes
		this._intervalTelnetRetryPending = setInterval(function() {
			this._initTelnet();
		}.bind(this), LB_TELNET_RETRY_INTERVAL);
	}.bind(this));

	this._telnetClient.on('connect', function() {
		this._logger.info('Lutron Bridge %s confirming Telnet', this.bridgeID);
		// however, we aren't functionally connected until the first GNET> prompt
	}.bind(this));

	this._telnetClient.connect(23, this.bridgeIP, function() {});

	this._telnetClient.setKeepAlive(true, 2000); // additionally, we'll ping once in a while to ensure re-connect

	function _telnetConnectConfirmed(telnetConnectConfirmedCallback) {
		this._telnetIsConnect = true;
		if (this._intervalTelnetRetryPending) {
			clearInterval(this._intervalTelnetRetryPending);
			this._intervalTelnetRetryPending = null;
		}
		this._logger.info('Lutron Bridge %s Telnet Connected!', this.bridgeID);

		// change the ping scheme to use Telnet instead of SSL for the Pro bridge
		if (this._intervalPing)
			clearInterval(this._intervalPing);
		this._expectPingback = false;
		this._intervalPing = setInterval(function() {
			if (this._telnetIsConnect && !this._expectPingback) {
				if (!this._expectResponse()) {
					this._logger.trace('Ping Bridge %s', this.bridgeID);
					process.stdout.write('                        \rPing ' + this.bridgeID + '... ');
					this._expectResponse(1);
					this._expectPingback = true;
					this._telnetClient.write('\r\n');
					// expected reply:
					// GNET>
				}
				// else avoid stepping on expected status response w/ping
			// else either disconnect from Telnet or no ping response
			// force a diconnect if necessary, wait out the socket timeout or other comm error that should ensue
			} else if (this._telnetClient !== null && !this._telnetClient.destroyed) {
				this._telnetIsConnect = false;
				this._telnetClient.destroy();
				this._telnetClient = null;
			}
		}.bind(this), LB_PING_INTERVAL);

		if (telnetConnectConfirmedCallback)
			telnetConnectConfirmedCallback();
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
		var aPico = this._allDevices.find(function(p) {
			return (p.ID == buttonDevice);
		}.bind(this));
		if (aPico && (aPico = this._picoList[aPico.SerialNumber]) &&
					 aPico.buttons.length >= (Number(buttonNumber) + 1)) {
			buttonMode.forceRelease = aPico.buttons[buttonNumber].to6Sec ?
									  BUTTON_FORCE.LONG_RELEASE : BUTTON_FORCE.NONE;
			buttonMode.rampHold = (aPico.buttons[buttonNumber].mode == 'Press/Repeat');
			buttonMode.pushTime = aPico.pushTime;
			buttonMode.repeatTime = aPico.repeatTime;
		}
	}
	return buttonMode;
}
Bridge.prototype._leapRequestZoneLevel = function(deviceZone) {
	this._writeSSL(communiqueBridgeZoneLevelRequest1of2 +
	               deviceZone +
	               communiqueBridgeZoneLevelRequest2of2);
	this._expectResponse(1);
}
Bridge.prototype._lookupDeviceIDByZone = function(deviceID, deviceZone) {
	if (!deviceID && deviceZone) { // if no device ID to use with telnet, reconstruct it from zone
		if (this._zoneList) {
			var dev = this._zoneList.device[deviceZone];
			deviceID = (dev && dev.ID) ? dev.ID : 0;
		}
	}
	return deviceID;
}
Bridge.prototype._lookupZoneByDeviceID = function(deviceID, deviceZone) {
	if (!deviceZone && deviceID) { // if no zone given, reconstruct it from device ID
		if (this._zoneList) {
			deviceZone = this._zoneList.device.findIndex(function(tzLD) {
				return (tzLD && (tzLD.ID == deviceID))
			}.bind(this));
			if (deviceZone <= 0)
				deviceZone = 0;
		}
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
			if (this._zoneList) {
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

	this._sslErrorCallback = function (err) {
		var aError = new Error('Wrong authentication for this bridge');
		aError.code = 'ECONNREFUSED';
		lbinitcallback(aError);	// no authorization found, not successfully initialized
		return;
	}.bind(this);
	var autherr = this._connectSSL(false, function lbGetInitialBridgeConfig(resumed) {
		this._sslErrorCallback = null;
		this._reconnectTries = 0;
		// various requests to acquire the initial devices list and its ancillary data
		this._logger.info('Lutron Bridge %s initial devices request', this.bridgeID);
		var beIGDCbFn;
		this._bridgeEvents.on(BE_GOTDEVICES, beIGDCbFn = function beInitGotDevices( gdbridgeix, gdbupdated) {
			this._bridgeEvents.removeListener(BE_GOTDEVICES, beIGDCbFn);
			// once we've got all the devices' info...
			// request and await the initial scenes list
			this._logger.info('Lutron Bridge %s initial scenes request', this.bridgeID);
			var beIGSCbFn;
			this._bridgeEvents.on(BE_GOTSCENES, beIGSCbFn = function beInitGotScenes( gsbridgeix, gdbupdated) {
				this._bridgeEvents.removeListener(BE_GOTSCENES, beIGSCbFn);
				// once we've got the scenes list...
				// wait until initial device list, initial level updates, initial scenes list before starting the Pro Bridge telnet client
				if (this._pro)
					this._initTelnet(bInitComplete.bind(this));
				else
					bInitComplete.call(this);
				return;

				function bInitComplete() {
					this.initialized = true;
					lbinitcallback(null);	// successfully initialized
				}
			}.bind(this));
			this._writeSSL(communiqueBridgeScenesRequest);
			this._expectResponse(1);
		}.bind(this));
		// request and await the initial intra-bridge servers list
		this._logger.info('Lutron Bridge %s initial intra-bridge servers request', this.bridgeID);
		this._writeSSL(communiqueBridgeServersRequest); // first find out what servers the bridge offers
		this._expectResponse(1);
	}.bind(this));
	if (autherr) {
		lbinitcallback(autherr);	// no authorization found, not successfully initialized
	}
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
	if (this._telnetIsConnect) {
		this._telnetIsConnect = false;
		this._telnetClient.end('LOGOUT\r\n');
		this._telnetClient = null;
	}
	if (this._sslConnected()) {
		this._sslClient.destroy();
	};
}
Bridge.prototype.writeBridgeCommunique = function(msgBody, cb) {	// for comm format tests
	var error = null;
	if (!this.initialized) {
		error = new Error('Uninitialized bridge');
		error.code = 'ENOBRIDGE';
	}
	else if (typeof msgBody === 'string') {
		var firstChar = msgBody.charAt(0);
		if (this._telnetIsConnect && ('?~#'.indexOf(msgBody.charAt(0)) >= 0)) {
			this._telnetClient.write(msgBody + '\r\n');
		}
		else
			error = new SyntaxError('Unknown Lutron Integration Profile Command (Telnet)');
	} else {
		try {
			this._writeSSL(JSON.stringify(msgBody) + '\n');
		} catch (e) { error = e }
	}
	if (typeof cb === 'function')
		cb(error);
}
Bridge.prototype.bridgeSummary = function() {
	var isConnected = this._sslConnected();
	var summary = {};
	summary[this.bridgeID] = {
		Connected: isConnected,
		Ip: this.bridgeIP,
		BridgeBrand: this.bridgeBrand
	};
	if (isConnected) {
		summary[this.bridgeID].DeviceType = this._bridgeModel;
		summary[this.bridgeID].Digest = (this._digestLeap + this._digestScenes);
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
	this._writeSSL(communiqueBridgeDevicesRequest);
	this._expectResponse(1);
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
	this._writeSSL(communiqueBridgeScenesRequest);
	this._expectResponse(1);
}
Bridge.prototype.allZoneRefresh = function() {
	this._zoneList.device.forEach(function(tzLD, tz) {
		this._leapRequestZoneLevel(tz);
	}.bind(this));
}
Bridge.prototype.sceneRequest = function(virtualButton, cb) {
	var error;
	// ensure this is a valid scene number, and permit request by scene name rather than number
	var snnameix = -1;
	if (virtualButton &&
		((this._allScenes.findIndex(function(tsn) {
				return (tsn && tsn.href && (tsn.href === ('/virtualbutton/' + virtualButton)));
			}.bind(this)) >= 0) ||
			((snnameix = this._allScenes.findIndex(function(tsn) {
				return (tsn && tsn.Name && (tsn.Name.toUpperCase() === virtualButton.toString().toUpperCase()));
			}.bind(this))) >= 0))) {
		if (snnameix >= 0) {
			virtualButton = Number(this._allScenes[snnameix].href.replace(
				/\/virtualbutton\//i, ''));
		}
		if (this._telnetIsConnect) {
			this._telnetClient.write('#DEVICE,1,' + virtualButton + ',' +
				BUTTON_OP_PRESS + '\r\n');
			//			this._telnetClient.write('#DEVICE,1,' + virtualButton + ',' + BUTTON_OP_RELEASE + '\r\n');
			this._expectResponse(1);
		}
		else {
			this._writeSSL(communiqueBridgeVirtualButtonPress1of2 +
				virtualButton +
				communiqueBridgeVirtualButtonPress2of2);
			this._expectResponse(1);
		}
		error = 0; // accepted
	}
	else
		error = new RangeError('No such scene'); // unknown scene
	if (typeof cb === 'function')
		cb(error);
}
Bridge.prototype.zoneStatusRequest = function(deviceZone, deviceID, cb) {

	if (this._telnetIsConnect) {
		// ST SmartApp may only send zone instead of both zone/device ID, for status inquiry, even for Pro bridge
		//		deviceID = _lookupDeviceIDByZone(lbridgeix,deviceID,deviceZone);
		if (deviceID) {
			this._telnetClient.write('?OUTPUT,' + deviceID + ',' + LIP_CMD_OUTPUT_REQ +
				'\r\n');
			this._expectResponse(1);
			if (typeof cb === 'function')
				cb(0);
			return;
		} // else no device ID can be determined, fall through to use the non-Pro zone scheme
	}
	deviceZone = this._lookupZoneByName(deviceZone);
	if (deviceZone) {
		this._leapRequestZoneLevel(deviceZone);

		var eventZLName = eventZoneLevel(this.bridgeID, deviceZone);
		var timerGetLevel;
		var handlerGetLevel = function(jsonResponse) {
			clearTimeout(timerGetLevel);
			if (typeof cb === 'function')
				cb(0, jsonResponse);
		}.bind(this);
		timerGetLevel = setTimeout(function() {
			// not required for .once! ... this._bridgeEvents.removeListener(eventZLName, handlerGetLevel);
			if (typeof cb === 'function')
				cb(408); // timeout
		}.bind(this), LB_REQUEST_TIMEOUT);

		this._bridgeEvents.once(eventZLName, handlerGetLevel);
	}
	else {
		if (typeof cb === 'function')
			cb(404); // unknown zone
	}
}
Bridge.prototype.zoneSetLevelCommand = function(deviceZone, deviceID, deviceLevel, deviceFadeSec, cb) {

	if (this._telnetIsConnect) {
		deviceID = this._lookupDeviceIDByZone(deviceID, deviceZone);
		if (deviceID) {
			this._telnetClient.write('#OUTPUT,' + deviceID + ',' + LIP_CMD_OUTPUT_SET +
				',' +
				deviceLevel +
				(deviceFadeSec ? (',' + deviceFadeSec) : '') +
				'\r\n');
			this._expectResponse(1);
			if (typeof cb === 'function')
				cb(0);
			return;
		} // else no device ID can be determined, fall through to try the non-Pro zone scheme
	}
	deviceZone = this._lookupZoneByName(deviceZone);
	if (deviceZone) {
		this._writeSSL(communiqueBridgeZoneLevel1of4 +
			deviceZone +
			communiqueBridgeZoneLevel2of4 +
			communiqueBridgeZoneLevelSet3of4 +
			deviceLevel +
			communiqueBridgeZoneLevelSet4of4);
		this._expectResponse(1);
		if (typeof cb === 'function')
			cb(0);
	}
	else {
		if (typeof cb === 'function')
			cb(404); // unknown zone
	}
}
Bridge.prototype.zoneChangeLevelCommand = function(deviceZone, deviceID, deviceLevelCmd, cb) {
	var rlsMap = {
		raise: [LIP_CMD_OUTPUT_RAISE, communiqueBridgeZoneLevelRaise3of4],
		lower: [LIP_CMD_OUTPUT_LOWER, communiqueBridgeZoneLevelLower3of4],
		stop: [LIP_CMD_OUTPUT_STOP, communiqueBridgeZoneLevelStop3of4]
	};

	var rlsCmd = rlsMap[deviceLevelCmd];
	if (!rlsCmd) {
		if (typeof cb === 'function')
			cb(400); // unknown command
		return;
	}
	if (this._telnetIsConnect) {
		deviceID = this._lookupDeviceIDByZone(deviceID, deviceZone);
		if (deviceID) {
			this._telnetClient.write('#OUTPUT,' + deviceID + ',' + rlsCmd[0] + '\r\n');
			this._expectResponse(1);
			if (typeof cb === 'function')
				cb(0);
			return;
		} // else no device ID can be determined, fall through to try the non-Pro zone scheme
	}
	deviceZone = this._lookupZoneByName(deviceZone);
	if (deviceZone) {
		this._writeSSL(communiqueBridgeZoneLevel1of4 +
			deviceZone +
			communiqueBridgeZoneLevel2of4 +
			rlsCmd[1] +
			communiqueBridgeZoneLevelRLS4of4);
		this._expectResponse(1);
		if (typeof cb === 'function')
			cb(0);
	}
	else {
		if (typeof cb === 'function')
			cb(404); // unknown zone or command
	}
}
Bridge.prototype.buttonRemoteAction = function(deviceSN, buttonNumber, action, cb) {
	var error;
	// ensure this is a valid Pico & button number, and permit request by Pico name rather than (serial) number
	var piconameix = -1;
	if (deviceSN && buttonNumber && action &&
		(((piconameix = this._allDevices.findIndex(function(tdv) {
				return (tdv && tdv.SerialNumber && (tdv.SerialNumber == deviceSN));
			}.bind(this))) >= 0) ||
			((piconameix = this._allDevices.findIndex(function(tdv) {
				return (tdv && tdv.Name && (tdv.Name.toUpperCase() === deviceSN.toString().toUpperCase()));
			}.bind(this))) >= 0))) {
		var lipID = Number(this._allDevices[piconameix].ID);
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
			if (this._telnetIsConnect) {
				this._telnetClient.write('#DEVICE,' + lipID + ',' + buttonNumber + ',' +	picoAction + '\r\n');
				this._expectResponse(1);
				if (picoHoldTime) {
					var picoHoldTimer = setTimeout(function(pLipID, pButtonNumber) {
						this._telnetClient.write('#DEVICE,' + pLipID + ',' + pButtonNumber + ',' + BUTTON_OP_RELEASE + '\r\n');
						this._expectResponse(1);
					}.bind(this, lipID, buttonNumber), picoHoldTime);
				}
			}
			else { // leap Pico commands are very picky about whether PressAndRelease or PressAndHold/Release are permitted
				var leapButtonIndex = -1;
				try {
					leapButtonIndex = this._picoList[deviceSN].buttons[buttonNumber].leapBIX;
				} catch (e) {
					this._logger.warn('Pico mode never received from SmartThings!');
				}
				// with a standard bridge, we have to echo back the app buttons  here, as the bridge won't
				if (!this._pro || leapButtonIndex < 0) {
					var jsonData = picoReportJSONFormatter(this, lipID, buttonNumber, action);
					this._sendHubJSON(jsonData);
				}
				if (leapButtonIndex >= 0) {
					var leapButton = this._picoList[deviceSN].leapButtons[leapButtonIndex];
					if (this._picoList[deviceSN].leapBPressAndHoldOK[leapButtonIndex]) {
						if (action == 'pushed')
							action = 'held';
					}
					else {
						if (action == 'closed' || action == 'held')
							action = 'pushed';
						else if (action == 'open')
							action = null;
					}
					if (action) {
						this._writeSSL(communiqueBridgePicoButtonAction1of3 +
							this._picoList[deviceSN].leapButtons[leapButtonIndex] +
							communiqueBridgePicoButtonAction2of3 +
							((action == 'open') ? communiqueBridgePicoButtonActionRelease3of3 :
								((action == 'pushed') ?
									communiqueBridgePicoButtonActionPressAndRelease3of3 :
									/* closed/held */
									communiqueBridgePicoButtonActionPressAndHold3of3
								)
							)
						);
						this._expectResponse(1);
						if (action == 'held') {
							var picoHoldTimer = setTimeout(function(pDeviceSN, pButtonNumber) {
								this._writeSSL(communiqueBridgePicoButtonAction1of3 +
									this._picoList[pDeviceSN].leapButtons[this._picoList[pDeviceSN].buttons[pButtonNumber].leapBIX] +
									communiqueBridgePicoButtonAction2of3 +
									communiqueBridgePicoButtonActionRelease3of3);
								this._expectResponse(1);
							}.bind(this, deviceSN, buttonNumber), picoHoldTime);
						}
					}
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
	// ensure this is a valid Pico number; this cannot be requested by Pico name
	var aPico = null;
	if (deviceSN)
		aPico = this._picoList[deviceSN];
	if (deviceSN && aPico && picoModeMap) {
		var lipArray = [];
		for (var lipB in picoModeMap) {	// transform remote map to sparse array by LIP button #
			lipArray[Number(lipB)] = picoModeMap[lipB];
		}
		var nButtons = 0;
		for (var lipBI in lipArray) {	// build index from LIP # into LEAP button array
			lipArray[lipBI].leapBIX = aPico.leapBNOffset + nButtons;
			nButtons++;
		};
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

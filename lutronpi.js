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
// v 1.1.0  lutronpro (original)        nate schwartz (github njscwartz)  with ICS license
// v 2.0.0+ lutronpi (forked)           wjh Bill hinkle (github billhinkle)
// v 2.0.0	2018.05.10 1200Z			wjh  Bill Hinkle (github billhinkle)
//	cleaned up some SmartThings comm, added self-identifying ST IP support
//	overrode express error handler transmission so SmartThings hub only sees a 500 Server Error now, not stack trace
//	dynamically select first free port from 5000 for SmartThings requests
//	modified ssdp advertisement:
//		start ssdp advertisement only after everything else initialized
//		advertises dynamically selected port (5000+),
//		advertises app-unique USN (uuid),
//		location is /subscribe 'til 1st ST GET there, then /connected so ST hub sees our restart & maybe IP/port change
//	added handling of multi-line telnet bursts (as in reply to scene requests via telnet)
//	added attempt to gracefully logout the bridge's telnet at shutdown or comm retry
//	restored  ST status/refresh checking for LC Pro bridge via telnet
//	restored  ST scene triggering for LC Pro bridge via telnet
//	modified SmartThings command responses to handle via Telnet if available, else SSL
//	added auto resume for tls/SSL connection to LC bridges, removed SSH references
//	added auto reconnect for tls/SSL and telnet connection to LC bridges on expected reply timeout & comm errors
//	added 1.5-minute ping watchdog to monitor LC bridge connection (via SSL or Telnet for Pro)
//	      ping watchdog is deferred when expecting a status response, since the (Telnet) ping response may corrupt it
//	added Pico-objects for multiple pico button press/held/ramp events in play simultaneously (can the LC bridge do that?)
//	added pseudo-release for pico buttons after timeout (buttons 1,2,3 won't release after ~6 sec)
//	added support for PJ2-4B Pico (4-buttons: codes 8,9,10,11) and several other Pico models
//	added server verb /button to allow SmartThings to pass back Pico button actions to the Lutron bridge(s)
//	added server verb /buttonmode to allow SmartThings to pass down Pico mode configurations (overrides local settings)
//	modified LIP-to-LEAP device matching to also require Area match if Area is defined in LIP data (w/ Name) & not overwrite IDs unnecessarily
//	added some parameter checking to scene requests from SmartThings & allowed request by scene name
//	added direct response to /status request & allowed request by DeviceName or Area:DeviceName
//	modified "Pro" bridge detection to use presence of enabled LIP server rather than model name string (for RA+ Select)
//           note that the LIP server will be enabled at initialization time if found disabled, but only that one time
//	added dimmer zone raise/lower/stop command support and fade-time support (pro only)
//	clarified some nomenclature, method, function and variable names, refactored some calling schemas
//  refactored bridge handler methods and ancillary functions into prototypes
// 	added Bonjour/mDNS discovery of SmartThings hub and Lutron bridges, including IP change monitoring
//	added Pico and Scene (virtual) button loopback so SmartThings app buttons can trigger Lutron functions also
//	added Pico button messaging to SmartThings upon initial press and release (slightly delayed on release to avoid SmartThings race)
//	added polling function to let SmartThings know when bridges come and go, and when devices/scenes change
//	added support for user-interactive authentication and persistent storage of authentication data by bridge ID
//	added support for multiple bridges throughout, with all SmartThings messaging tagged by bridge and device S/N (and/or zone)
//	split out bridge and supervisory functions into separate modules, hopefully allowing additional bridge types as plug-ins
//  added start-time synchronous tasking to allow bridges to initialize without stepping over each other in the log
//	modified startup calling scheme to allow no-parameters start of this module directly (default=Lutron & SmartThings discovery) or
//           allow for a more complete specification of bridge types, IDs, network addresses, authentication and SmartThings IP
'use strict';
const LUTRONPI_VERSION = '2.0.0 2018.05.10 1200Z';
console.log('%s Version %s', process.argv[1], LUTRONPI_VERSION);
const mainHomeDir = process.mainModule.paths[0].split('node_modules')[0].slice(0, -1);
// console.log('Root dir=%s',mainHomeDir);

var exports = module.exports = {};

// const assert = require('assert');
const log = require('loglevel');
log.setLevel('debug')
const logComm = log.getLogger('Comm');
logComm.setLevel('info')

var tryRequire = require('try-require');

const getport = require('getport');
const dns = require('dns');
const request = require('request');
const express = require('express');
const bodyParser = require('body-parser');
const ssdp = require('node-ssdp');
const ssdpServer = ssdp.Server;
const ssdpClient = ssdp.Client;
// const uuidv1 = require('uuid/v1');
const ip = require('ip');
const ipaddr = require('ipaddr.js');
const mDNSHandler = require('./lib/bonjour-up')();
const eventEmitter = require('events');
const fs = require('fs');

const userConsole = require('readline-sync');
const taskQueue = require('queue');

const BRIDGE_DISCOVERY_TIMEOUT = 2000; //milliseconds

var devBridge = [];					// per-bridge objects array
var devBridgeAuthInfo = [];
var devBridgeByID = [];				// ID-to-bridge lookup
const devBridgeEvents = new eventEmitter();
const DBE_GOTINIT = 'gotinit';
const DBE_FOUNDBRIDGE = 'foundbridge';

const communiqueServerSummaryResponse1of2 =
	'{"CommuniqueType": "ServerResponse","Header": {"MessageBodyType": "LutronPiSummary"},"Body": {';
const communiqueServerSummaryResponse2of2 = '}}';
const communiqueServerNotifyRequest =
	`{"CommuniqueType": "ServerRequest","Header": {"MessageBodyType": "LutronPiNotify"},"Body": {"Now": ${new Date().getTime()}}}`;

const SSDP_USN_URN = 'urn:schemas-upnp-org:device:LutronPi_BridgeThing:1';
const SSDP_USN_UUID = 'f40c2981-7329-40b7-8b04-27f187aecfb5';

const DEFAULT_REQST_PORT = 5000;		// this may be dynamically changed at startup if the default port is in use
const DEFAULT_ST_LAN_PORT = 39500;		// todo: this could be (re-)set dynamically upon ST subscription via /subscribe
var SMARTTHINGS_ID = null;
var SMARTTHINGS_IP = null;
var SMARTTHINGS_PORT = DEFAULT_ST_LAN_PORT
var stReqPort = DEFAULT_REQST_PORT;
var stReqServer = null;
var stSubscribed = false;
var stSSDP = null;
var mySSDP = null;

const sentHubEvents = new eventEmitter();	// provides broadcast to bridges of unsolicited event communications to SmartThings
const SHE_SENT = 'sheSent';

// ------------------

const app = express();
app.use(bodyParser.json());

app.put('/subscribe', function(req, res) { // ST hub can post here to 'subscribe' to this server and inform of its IP:Port
	// todo: check for good hub signature in GET request before believing it's an ST hub!
	// todo: check for SMARTTHINGS_IP = req.ip;
	// todo: OR maybe update the IP from the signature data and the Port too?
	try {
		logComm.debug('Subscription sig %o', req.body);
		var stSubscriberAddress = req.body.Hub.split(':')
	}
	catch (e) {};
	stSubscribed = true;
	logComm.info('ST hub at %s (re-)subscribed to %i bridge(s) at ' + (new Date()) + "\nST hub signature=%o",
	             ipaddr.process(req.ip).toString(), devBridge.length, stSubscriberAddress);

	res.setHeader('Content-Type', 'application/json');
	res.send(communiqueServerSummary());
});

app.put('/unsubscribe', function(req, res) { // ST hub can post here to 'unsubscribe'
	try {
		logComm.info('Unsubscription sig %o', req.body);
		var stSubscriberAddress = req.body.Hub.split(':');
		var aLen = stSubscriberAddress.length;
		if ((aLen >= 2) &&
			(stSubscriberAddress[aLen - 2] == SMARTTHINGS_IP) &&
			(stSubscriberAddress[aLen - 1] == SMARTHINGS_PORT)) {
			stSubscribed = false;
			logComm.info('ST hub at %s unsubscribed at ' + (new Date()), SMARTTHINGS_IP);
			res.sendStatus(200);
		}
	}
	catch (e) {};
	res.sendStatus(400); // unknown hub subscription
});

app.get('/connected', function(req, res) {
	logComm.info("ST hub at %s connection to %i bridges at " + (new Date()), req.ip, devBridge.length);

	res.setHeader('Content-Type', 'application/json');
	res.send(communiqueServerSummary());
});

app.get('/poll', function(req, res) {
	logComm.debug('ST hub at %s polled %i bridges at ' + (new Date()), req.ip, devBridge.length);

	res.setHeader('Content-Type', 'application/json');
	res.send(communiqueServerSummary());
});

function communiqueServerSummary() {
	var allBridges = {};
	for (var i in devBridge) { // get summary for all known bridges
		allBridges = Object.assign(allBridges, devBridge[i].bridgeSummary());
	}
	var communique = communiqueServerSummaryResponse1of2 +
		'"Version":"' + LUTRONPI_VERSION + '",' + 
		'"Bridges":' + JSON.stringify(allBridges) +
		communiqueServerSummaryResponse2of2;
	return communique;
}

app.get('/devices', function(req, res) {
	logComm.info('ST device list request: %i bridges', devBridge.length);

	var gdbridgecnt = devBridge.length;
	if (!gdbridgecnt) {
		res.sendStatus(404); // we don't know any bridges
		return;
	}

	// if this reply is to the SmartThings hub, reset all bridges' updated-devices flag
	const stReqd = ip.isEqual(req.ip, SMARTTHINGS_IP);

	var gdbridgeok = [];
	for (var i in devBridge) { // request a fresh list of devices for all known bridges
		gdbridgeok[i] = false;
		devBridge[i].deviceListRequest(i, stReqd, deviceReqGotDevicesCallback);
	}

	var combinedDevicesList = [];
	function deviceReqGotDevicesCallback(gdbridgeix, gdbridgeDevList) {
		if (!gdbridgeok[gdbridgeix]) {
			gdbridgeok[gdbridgeix] = true;
			gdbridgecnt--;
		}
		logComm.info('Bridge %s device list refreshed', devBridge[gdbridgeix].bridgeID);
		combinedDevicesList = combinedDevicesList.concat(gdbridgeDevList);

		if (!gdbridgecnt) {	// all requested bridges have replied
			res.setHeader('Content-Type', 'application/json');
			res.send(combinedDevicesList);
		}
	}
});

app.get('/scenes', function(req, res) {
	logComm.info('ST scenes list request: %i bridges', devBridge.length);

	var gsbridgecnt = devBridge.length;
	if (!gsbridgecnt) {
		res.sendStatus(404); // we don't know any bridges
		return;
	}

	// if this reply is to the SmartThings hub, reset all bridges' updated-scenes flag
	const stReqd = ip.isEqual(req.ip, SMARTTHINGS_IP);

	var gsbridgeok = [];
	for (let i in devBridge) { // for all known bridges
		gsbridgeok[i] = false;
		devBridge[i].sceneListRequest(i, stReqd, deviceReqGotScenesCallback);
	}

	var combinedScenesList = [];
	function deviceReqGotScenesCallback(gsbridgeix, gsbridgeScenesList) {
		if (!gsbridgeok[gsbridgeix]) {
			gsbridgeok[gsbridgeix] = true;
			gsbridgecnt--;
		}
		logComm.info('Bridge %s scenes list refreshed', devBridge[gsbridgeix].bridgeID);
		combinedScenesList = combinedScenesList.concat(gsbridgeScenesList);

		if (!gsbridgecnt) {	// all requested bridges have replied
			res.setHeader('Content-Type', 'application/json');
			res.send(combinedScenesList);
		}
	}
});

app.post('/scene', function(req, res) {
	var reqBridge = requestBridge(req.body);
	if (!reqBridge) {
		res.sendStatus(404); // we don't know this particular bridge
		return;
	}
	logComm.info('ST req: Bridge %s scene %s          ', reqBridge.bridgeID, req.body.virtualButton);
	reqBridge.sceneRequest(req.body.virtualButton, function(err) {
		if (err)
			res.sendStatus(404); // we don't know this particular scene
		else
			res.sendStatus(202); // accepted
	});
});

app.post('/button', function(req, res) {
	var reqBridge = requestBridge(req.body);
	if (!reqBridge) {
		res.sendStatus(404); // we don't know this particular bridge
		return;
	}
	logComm.info('ST req: Bridge %s button %s:%i action %s',
		reqBridge.bridgeID, req.body.deviceSN, req.body.buttonNumber, req.body.action
	);
	reqBridge.buttonRemoteAction(req.body.deviceSN, req.body.buttonNumber, req.body.action,
		function(err) {
			if (err)
				res.sendStatus(404); // we don't know this particular remote, button, etc
			else
				res.sendStatus(202); // accepted
		});
});

app.post('/buttonmode', function(req, res) {
	var reqBridge = requestBridge(req.body);
	if (!reqBridge) {
		res.sendStatus(404); // we don't know this particular bridge
		return;
	}
	logComm.info('ST req: Bridge %s button %s mode set', reqBridge.bridgeID, req.body.deviceSN);
	reqBridge.buttonRemoteSetMode(req.body.deviceSN, req.body.buttons, req.body.pushTime, req.body.repeatTime, function(err) {
		if (err)
			res.sendStatus(404); // we don't know this particular remote, button, etc
		else
			res.sendStatus(202); // accepted
	});
});

app.post('/status', function(req, res) {
	var reqBridge = requestBridge(req.body);
	if (!reqBridge) {
		res.sendStatus(404); // we don't know this particular bridge
		return;
	}
	var deviceID = req.body.deviceID;
	var deviceZone = req.body.zone;
	logComm.info('ST req: Bridge %s, %s  %s',
	             reqBridge.bridgeID,
	             deviceZone?'Zone ' + deviceZone:'',
	             deviceID?'ID ' + deviceID:'');

	reqBridge.zoneStatusRequest(deviceZone, deviceID, function(err, jsonResponse) {
		if (err)
			res.sendStatus(err); // we don't know this particular zone or ID
		else {
			res.setHeader('Content-Type', 'application/json');
			res.send(jsonResponse);
		}
	});
});

app.post('/setLevel', function(req, res) {
	var reqBridge = requestBridge(req.body);
	if (!reqBridge) {
		res.sendStatus(404); // we don't know this particular bridge
		return;
	}

	var deviceID = req.body.deviceID;
	var deviceZone = req.body.zone;
	var deviceLevel = req.body.level;
	if (['raise', 'lower', 'stop'].includes(deviceLevel)) {
		logComm.info('ST req: Bridge %s fade %j', reqBridge.bridgeID, req.body);
		reqBridge.zoneChangeLevelCommand(deviceZone, deviceID, deviceLevel,
			function(err) {
				if (err)
					res.sendStatus(err);
				else
					res.sendStatus(202); // accepted
			});
	}
	else {
		var deviceLevel = req.body.level;
		var deviceFadeSec = req.body.fadeSec;
		logComm.info('ST req: Bridge %s set level %j', reqBridge.bridgeID, req.body);

		try {
			deviceLevel = Math.round(Math.min(100, Math.max(0, deviceLevel)));
		}
		catch (e) {
			deviceLevel = 0;
		}
		reqBridge.zoneSetLevelCommand(deviceZone, deviceID, deviceLevel,
			deviceFadeSec,
			function(err) {
				if (err)
					res.sendStatus(err);
				else
					res.sendStatus(202); // accepted
			});
	}
});

app.post('/on', function(req, res) {
	var reqBridge = requestBridge(req.body);
	if (!reqBridge) {
		res.sendStatus(404); // we don't know this particular bridge
		return;
	}
	var deviceID = req.body.deviceID;
	var deviceZone = req.body.zone;
	logComm.info('ST req: Bridge %s on %j', reqBridge.bridgeID, req.body);

	reqBridge.zoneSetLevelCommand(deviceZone, deviceID, 100, 0, function(err) {
		if (err)
			res.sendStatus(err);
		else
			res.sendStatus(202); // accepted
	});
});

app.post('/communique', function(req, res) {
	var reqBridge = requestBridge(req.body);
	if (!reqBridge) {
		res.sendStatus(404); // we don't know this particular bridge
		return;
	}

	logComm.info('Bridge %s communique:', reqBridge.bridgeID, req.body);
	reqBridge.writeCommunique(req.body, function(err) {
		if (err)
			res.sendStatus(400);	// bad request of one sort or another
		else
			res.sendStatus(202);	// accepted
	});
});

app.use(function(err, req, res, next) { // make sure this is the last express app middleware.
	logComm.error(err);
	res.sendStatus(400);
});

process.on('uncaughtException', function(err) {
	log.error('Caught exception: ', err.code);
	//  var stack = new Error().stack;
	//  log.error( stack );
	throw (err);
});

process.on('exit', function(code) {
	for (var i in devBridge) {
		devBridge[i].disconnect();
	}
	log.error('\r\nExiting with code:', code);
});

process.on('SIGINT', function() {
	//graceful shutdown on Ctrl+C
	process.exit(2);
});

function requestBridge(reqbody) {
	if (reqbody.bridge === undefined)
		return devBridge[0]; // compatibility default bridge is index 0
	else // null if bridge is unknown, else the SN-selected bridge
		return (reqbody.bridge in devBridgeByID) ? devBridgeByID[reqbody.bridge] : null;
}

// ------------------

function stHubDiscover(discovery, logger, stHubFoundCallback) { // discovery = boolean stop/run, stHubFoundCallback(stHubID,stHubIP,isupdate)
	if (!logger)
		logger = function () { };
	var mdnsSTHub = null;

	if (discovery) {
		mdnsSTHub = mDNSHandler.find({ type: 'smartthings' },	function sniffSTHubs(stService, isupdate) {
			var stHubIP = stService.addresses.find( function(addr) {
				return ip.isV4Format(addr);
			});
			if (!stHubIP)
				stHubIP = ipaddr.process(stService.addresses[0]).toString();
			// we really want a notification when any of this changes, too
			if (!isupdate) {
				logger('\n...SmartThings hub mDNS %s / now %d service(s) : %s',
				       (isupdate) ? 'updated' : 'found', mdnsSTHub.services.length, (new Date()));
				logger('...SmartThings hub mDNS IP: ' + stHubIP);
				logger('...SmartThings hub mDNS Name: ' + stService.name);
				logger('...SmartThings hub mDNS FQDN: ' + stService.fqdn);
				logger('...SmartThings hub mDNS Host: ' + stService.host);
				logger('...SmartThings hub mDNS TTL (sec): ' + stService.ttl);
			}
			stHubFoundCallback(stService.name, stHubIP, isupdate);
		});
		mdnsSTHub.on('down', function downSTHubs(stService) {
			var stHubIP = stService.addresses.find( function(addr) {
				return ip.isV4Format(addr);
			});
			if (!stHubIP)
				stHubIP = ipaddr.process(stService.addresses[0]).toString();
			logger('\n...SmartThings hub mDNS down / now %d service(s): %s', mdnsSTHub.services.length, (new Date()));
			logger('...SmartThings hub mDNS IP: ' + stHubIP);
			logger('...SmartThings hub mDNS Name: ' + stService.name);
			logger('...SmartThings hub mDNS FQDN: ' + stService.fqdn);
			logger('...SmartThings hub mDNS Host: ' + stService.host);
		});
	} else if (mdnsSTHub) {
		mdnsSTHub.stop();
		mdnsSTHub = null;
	}
}

function ssdpDetectedServer (headers, statusCode, rinfo) {
	if (ip.isEqual(ip.address(), rinfo.address)) { // ip of "http://192.168.0.195:5000/connected"
		logComm.error('This server is already running at this network address! Exiting...');
		process.exit(2);
	}
}

function ssdpServerSearch () {	// search for this same server running at this same network address
	mySSDP = new ssdpClient({});

	mySSDP.on('response', ssdpDetectedServer);
	mySSDP.search(SSDP_USN_URN);
}

function ssdpConnectLocation() {
	logComm.trace('SSDP update: %s:%s: SmartThings at %s is ', ip.address(), stReqPort, SMARTTHINGS_IP, (SMARTTHINGS_IP ? 'connected' : 'waiting'));
	return 'http:\/\/' + ip.address() + ':' + stReqPort + (stSubscribed ? '/connected' : '/subscribe');
}

function updateSmartThingsComm(aSmartThingsID, aSmartThingsIP) {
	if (aSmartThingsID != SMARTTHINGS_ID || aSmartThingsIP == SMARTTHINGS_IP)
		return false;

	dns.lookup(aSmartThingsIP, 4, function(err, address, family) {
		if (err)
			SMARTTHINGS_IP = aSmartThingsIP;
		else
			SMARTTHINGS_IP = address;
	});

	stSubscribed = false;

	// send a pseudo-NOTIFY to the SmartThings hub (SmartApp) to request connection resume
	sendSmartThingsJSON(JSON.parse(communiqueServerNotifyRequest));
	return true;
}

function shutdownSmartThingsComm() {
	if (stSSDP)
		stSSDP.stop(); // advertise shutting down and stop listening
	if (stReqServer)
		stReqServer.close();
}

function initSmartThingsComm(initSmartThingsID, initSmartThingsIP) {	// initialize communications with SmartThings hub

	if (SMARTTHINGS_ID)
		return;

	if (mySSDP) {	// if we got this far, there probably isn't another copy of this server running locally
		mySSDP.removeAllListeners('response').stop();
	}

	SMARTTHINGS_ID = initSmartThingsID;

	dns.lookup(initSmartThingsIP, 4, function(err, address, family) {
		if (err)
			SMARTTHINGS_IP = initSmartThingsIP;
		else
			SMARTTHINGS_IP = address;
	});

	// find a localhost port we can use to receive ST requests, then advertise for ST connection
	getport(DEFAULT_REQST_PORT, function(err, p) {
		if (err) throw (err);

		stReqPort = p;
		stReqServer = app.listen(stReqPort);
		logComm.info('Listening for SmartThings requests at %s:%d...', ip.address(), stReqPort);

		//SSDP server for SmartThings discovery of our service
		stSSDP = new ssdpServer({
					sourcePort: 1900,
					udn: 'uuid:' + SSDP_USN_UUID, // derived from uuidv1(),
					adInterval: 600000, // every 10 minutes, since ST hub isn't listening to NOTIFY anyway
					suppressRootDeviceAdvertisements: true,
					//      location: 'http:\/\/' + ip.address() + ':' + DEFAULT_REQST_PORT + '/status',
					location: ssdpConnectLocation,
		});

		stSSDP.addUSN(SSDP_USN_URN);

		process.on('exit', shutdownSmartThingsComm );

		stSSDP.start(); // start the SSDP advertisment once we're listening

		// send a pseudo-NOTIFY to the SmartThings hub (SmartApp) to request connection resume
		// since the SmartThings hub does not seem to listen to ssdp NOTIFY multicasts
		sendSmartThingsJSON(JSON.parse(communiqueServerNotifyRequest));
	});
}

function sendSmartThingsJSON(jsonData) {	// common function to send to ST
	if (ipaddr.isValid(SMARTTHINGS_IP)) {
		logComm.info('Sending to SmartThings @ %s:%s', SMARTTHINGS_IP, SMARTTHINGS_PORT);
		logComm.trace(jsonData);

		request({
			url: 'http:\/\/' + SMARTTHINGS_IP + ':' + SMARTTHINGS_PORT,
			method: 'POST',
			json: true, // self-stringifies body object to JSON
			body: jsonData
		}, function(error, response, body) {
			if (error)
				//	  throw(error);
				logComm.warn('SmartThings hub is not listening at ' + SMARTTHINGS_IP + ':' + SMARTTHINGS_PORT);
		});
	}
	else logComm.warn('SmartThings hub is not connected yet!');
	sentHubEvents.emit(SHE_SENT, jsonData);	// also send same data to any bridges listening
}

// ------------------

// provides persistent authorization namespace
function persistAuthKeyFileName(bridgeType, bridgeIdentifier) {
	return bridgeType + '-' + bridgeIdentifier + '.key'
}
// provides retrieval of persistent authorization info
function persistAuthGet(bridgeType, bridgeIdentifier) {
	// use a persistent reference from bridgeIdentifier to identify this file
	try {
		return JSON.parse(fs.readFileSync(persistAuthKeyFileName(bridgeType,bridgeIdentifier)));
	} catch (e) { return null; }
}
// provides storage of persistent authorization info
function persistAuthPut(bridgeType, bridgeIdentifier, authObject) {
	// write out a persistent reference from bridgeIdentifier to later identify this file
	fs.writeFileSync(persistAuthKeyFileName(bridgeType, bridgeIdentifier), JSON.stringify(authObject));
}

// ------------------

// bridge connection object
function BridgeConnect (bridgeType, bridgeID, bridgeIP, bridgeAuth, bridgeInst) {
	this.bType = bridgeType;
	this.bID = bridgeID;
	this.bIP = bridgeIP;
	this.bAuth = bridgeAuth;
	this.bInst = bridgeInst;
}
// bridge connection lists
var bridgeConnectList = [];
var bridgeDiscoverList = [];
var bridgeDiscoveryModule = [];
var bridgeAuthModule = [];
var bridgeOperationModule = [];
var bridgeIPIgnoreList = [];
var bridgeIDIgnoreList = [];
var bridgeInitCnt = 0;

// provides bridge operational module path: ./bridges/xxx preferred, ./xxx will do
// note that try-require messes up the usual ./ module search, hence explcit mainHomeDir here
function bridgeModulePath(prefPathIX) {
	return mainHomeDir + '/' + (prefPathIX ? '' : 'bridges/');
}
// provides bridge discovery module namespace/path
function bridgeDiscoveryModulePath(bridgeType, prefPathIX) {
	return bridgeModulePath(prefPathIX) +
	       bridgeType + '-discover';
}
// provides bridge operational module namespace/path
function bridgeOperationModulePath(bridgeType, prefPathIX) {
	return bridgeModulePath(prefPathIX) +
	       bridgeType + '-bridge';
}
// provides bridge authorization module namespace/path
function bridgeAuthModulePath(bridgeType, prefPathIX) {
	return bridgeModulePath(prefPathIX) +
	       bridgeType + '-auth';
}

// require bridge discovery module (if needed) and return true if success, else false if failed require
function bridgeDiscoveryModuleRequire(bType) {
	let bDModFile = bridgeDiscoveryModulePath(bType);
	if (!bridgeDiscoveryModule[bType]) {
		log.info('Requiring ', bDModFile);
		var bDMod = tryRequire(bDModFile, 0) || tryRequire(bDModFile, 1);
		if (bDMod)
			bridgeDiscoveryModule[bType] = bDMod;
		else {
			log.info('Discovery unavailable for bridge type:', bType);
			return false;
		}
	}
	return true;
}
// require bridge operation module (if needed) and return true if success, else false if failed require
function bridgeOperationModuleRequire(bType) {
	let bOModFile = bridgeOperationModulePath(bType);
	if (!bridgeOperationModule[bType]) {
		log.info('Requiring ', bOModFile);
		var bOMod = tryRequire(bOModFile, 0) || tryRequire(bOModFile, 1);
		if (bOMod)
			bridgeOperationModule[bType] = bOMod;
		else {
			log.info('Unknown bridge type:', bType);
			return false;
		}
	}
	return true;
}
// require bridge authentication module (if needed) and return true if success, else false if failed require
function bridgeAuthModuleRequire(bType) {
	let bAModFile = bridgeAuthModulePath(bType);
	if (!bridgeAuthModule[bType]) {
		log.info('Requiring ', bAModFile);
		var bAMod = tryRequire(bAModFile, 0) || tryRequire(bAModFile, 1);
		if (bAMod)
			bridgeAuthModule[bType] = bAMod;
		else {
			log.info('No authentication available for bridge type:', bType);
			return false;
		}
	}
	return true;
}


// Main startup / supervisor
exports.startup = function(bridgeSpec, stHubIP) {
	/*	 bridgeSpec is either single map object or an array of such map objects in the form:
		{type: 'Lutron', id: 'UNIQUEID', ip: '192.168.0.99', auth: {user: 'you@yourmail.com', password: 'asecret'}}
		where:
			type is a known bridge type, e.g. Lutron (case insensitive) - String
				(if missing/null/empty/false, ignore any bridge with specified id or at that ip address entirely)
			id is a unique identifier for the specified bridge e.g. S/N (case insensitive) - String
				(if id is missing/null/empty/false, one MAY be assigned later)
			ip is the specified bridge's local IP address in V4 format - String
				(if ip is missing/null/empty/false, discover this bridge type)
			auth (authorization) is the specified bridge's authorization information, e.g. object w/ user/password
				(if missing/null/empty/false, will be requested from the user at bridge initialization)
				e.g. for Lutron: auth: {user: 'you@yourmail.com', password: 'asecret'}}

		Lutron discovery occurs by default UNLESS any one specific bridge is specified as a Lutron type
		Other bridge types will not be discovered unless that type is specified _only_ w/o ID/IP/Auth

		stHubIP is the IP address of the SmartThings hub
			(or its local DNS host name, though this may become unavailable after a local router reboot)
		where if missing, undefined, empty or null, discovery will be used to find the FIRST SmartThings hub that replies
	*/

	ssdpServerSearch();		// check to see if this server is already running; check back later for replies

	var initTaskQ = taskQueue({concurrency: 1, autostart: true});	// ensure synchronous initialization tasking

	if (!bridgeSpec) {						// decipher the bridge specifications, if any supplied
		bridgeDiscoverList[0] = 'lutron';	// default to Lutron discovery if nothing else is specified
	} else {
		var bSpecArray = [].concat(bridgeSpec || []);	// either a single spec object or an array of them is OK
		for (let b = 0; b < bSpecArray.length; b++) {
			if (!bSpecArray[b].type) {	// if no type is specified, ignore this bridge by ID and/or IP
				if (bSpecArray[b].id)
					bridgeIDIgnoreList.push(bSpecArray[b].id);
				if (bSpecArray[b].ip)
					bridgeIPIgnoreList.push(bSpecArray[b].ip);
			}
			else {
				var bType = bSpecArray[b].type.toLowerCase();
				var bIP = bSpecArray[b].ip ? bSpecArray[b].ip : null;
				if (!bIP) {		// no IP specified, put this type of bridge on the discovery list
					if (bridgeDiscoverList.indexOf(bType) < 0)
						bridgeDiscoverList.push(bType);

					if (!bSpecArray[b].id && !bSpecArray[b].auth)
						bType = null;
				}
				if (bType) {	// if a type and address are specified, place this bridge on the connection list
					bridgeConnectList.push(new BridgeConnect(bType,
					                                         bSpecArray[b].id ? bSpecArray[b].id.toUpperCase() : null,
					                                         bIP,	// leave address validation to the individual bridges
					                                         bSpecArray[b].auth ? bSpecArray[b].auth : null,
					                                         null ));

					// as any one bridge of this type is fully/sufficiently specified, do not discover this bridge type
					// var bTix = bridgeDiscoverList.indexOf(bType);
					// if (bTix >= 0)
					//	bridgeDiscoverList.splice(bTix, 1);
				}
			}
		}
	}

	// list further bridges as they are discovered, either at startup or later (after SmartThings comm begins)
	devBridgeEvents.on(DBE_FOUNDBRIDGE, function dbeBridgeFound(bridgeType, bridgeID, bridgeIP) {

		bridgeConnectList.push(new BridgeConnect(bridgeType, bridgeID, bridgeIP, null, null ));

		if (SMARTTHINGS_ID)
			bridgeLateInitializers();	// post-startup, create and initialize all late-discovered bridges
	});

	log.debug('bridgeDiscoverList=%o',bridgeDiscoverList);
	// load the necessary discovery modules
	for (let d = 0; d < bridgeDiscoverList.length; d++) {
		if (!bridgeDiscoveryModuleRequire(bridgeDiscoverList[d]))
			bridgeDiscoverList.splice(d, 1);
	}

	for (let d = 0; d < bridgeDiscoverList.length; d++) {
		log.info('Discovering %s bridges...', bridgeDiscoverList[d]);
		bridgeDiscoveryModule[bridgeDiscoverList[d]].discover(true, logComm.info,
		                                                      function foundBridge (bridgeType, bridgeID, bridgeIP, isupdate) {
			// list the bridges as discoveries arrive

			// check the ignore lists and ignore any bridge we find that's on those lists
			if (bridgeIPIgnoreList.some( function (bIP) { return (bIP == bridgeIP) || ip.isEqual(bIP,bridgeIP) } ))
				return;
			if (bridgeIDIgnoreList.some( function (bID) { return bID == bridgeID } ))
				return;

			bridgeType = bridgeType.toLowerCase();
			let b = bridgeConnectList.findIndex( function (bC) {	// see if this bridge is already listed
				return (bC.bID == bridgeID && bC.bType == bridgeType)
			});
			if (!isupdate) {	// newly discovered bridge
				if (b < 0) {	// it hasn't already been listed by type/ID, fire off the found-bridge event
					devBridgeEvents.emit(DBE_FOUNDBRIDGE, bridgeType, bridgeID, bridgeIP);
				}
				else 	// already listed, maybe just later updating the IP/address by discovery
					isupdate = true;
			}
			if (isupdate && bridgeIP && (b >= 0)) {	// possibly an IP change; let the bridge decide what to do about that
				if (bridgeConnectList[b].bIP != bridgeIP) {
					bridgeConnectList[b].bIP = bridgeIP;
					if (bridgeConnectList[b].bInst)
						bridgeConnectList[b].bInst.updateBridgeComm(bridgeIP);
				}
			}
		});
	}


	// allow a little time for initial bridge discovery to complete, then initialize all listed bridges
	var bridgeInitDiscoverTimer = setTimeout( function bridgeAllInitFound () {
		// 	all initial bridges have presumably been discovered by now

		bridgeInitCnt = bridgeConnectList.length;
		if (!bridgeInitCnt) {
			log.warn('No bridges specified or discovered');
			clearTimeout(bridgeInitDiscoverTimer);
			for (let d = 0; d < bridgeDiscoverList.length; d++) {
				bridgeDiscoveryModule[bridgeDiscoverList[d]].discover(false);
			}
			process.exit(0);
			return;
		}

		log.debug('bridgeConnectList=%o',bridgeConnectList);
		// load the necessary bridge operation modules
		for (let b = 0; b < bridgeInitCnt; b++) {
			if (!bridgeOperationModuleRequire(bridgeConnectList[b].bType))
				bridgeConnectList[b].bType = null;
		}

		// create all bridge instances from the create/initialize list
		var devBridgeInitOK = [];
		for (let b = 0; b < bridgeInitCnt; b++) {
			// if no ID is supplied, make one up based on the specified address field (IP)
			if (!bridgeConnectList[b].bID && bridgeConnectList[b].bIP) {
				if (ip.isV4Format(bridgeConnectList[b].bIP))
					bridgeConnectList[b].bID = 'X' + (ip.toLong(bridgeConnectList[b].bIP) >>> 0).toString(16).padStart(8,'0').toUpperCase();
				else
					bridgeConnectList[b].bID = 'X' + bridgeConnectList[b].bIP.substr(0,8).toUpperCase();
			}
			if (bridgeConnectList[b].bType && bridgeConnectList[b].bID && bridgeConnectList[b].bIP) {
				// make sure we have a known bridge class and ignore any trailing duplicates in the list
				if (bridgeCreate(b)) {	// create the bridge object as specified
					// note any preset authorization info, and that the bridge is not yet initialized
					devBridgeAuthInfo.push(bridgeConnectList[b].bAuth ? bridgeConnectList[b].bAuth : null);
					devBridgeInitOK.push(false);
				}
			}
		}

		// wait for all initializing bridges to report back then connect to the SmartThings hub
		var bridgeDevCnt = devBridge.length;
		devBridgeEvents.on(DBE_GOTINIT, function dbeReqGotInit(b, bridgeinitok) {
			if (!devBridgeInitOK[b]) {	// ensure all bridge initializations have reported back, good or bad
				devBridgeInitOK[b] = bridgeinitok;
				bridgeDevCnt--;
			}
			if (!bridgeDevCnt) {		// all bridges have completed their full initialization process
				devBridgeEvents.removeListener(DBE_GOTINIT, dbeReqGotInit);

				// we're ready to talk to the SmartThings hub
				if (stHubIP)	// SmarThings Hub address is fixed IP or hostname, no discovery
					initSmartThingsComm('smartthings', ipaddr.isValid(stHubIP)? ipaddr.process(stHubIP).toString() : stHubIP);
				else {	// unless overridden with a specific IP address, discover the SmartThings hub
					logComm.info('Discovering SmartThings hub on local network...');
					stHubDiscover(true, logComm.info, function foundSTHub (hubID, hubIP, isupdate) {
						if (!isupdate)
							initSmartThingsComm(hubID, hubIP);
						else if (hubIP) {
							if (updateSmartThingsComm(hubID, hubIP))
								logComm.info('\n...SmartThings hub IP updated to %s : %s', hubIP, (new Date()));
						}
					}.bind(this));
				}
				bridgeLateInitializers();	// create and initialize any late-discovered bridges
			}
		});
		// initialize all listed bridges, more or less synchronously
		for (let b = 0; b < devBridge.length; b++) {
			taskBridgeInit(b, initTaskQ);
		}
		// once all the initial bridges are initialized (or not), any newly-discovered bridges can be initialized one-by-one

	}, BRIDGE_DISCOVERY_TIMEOUT);
}

// this module can be run directly from Node: so self-start with no parameters
if (!module.parent) {
	exports.startup();
}

// bridge initialization utility functions

// create operational bridge instance from full bridge connect spec
function bridgeCreate(b) {
	let bridgeID = bridgeConnectList[b].bID;
	let bridgeIP = bridgeConnectList[b].bIP;
	// create a bridge object only if this is the first/unique bridge with this ID and address
	if (b == bridgeConnectList.findIndex( function (bC) { return bC.bID == bridgeID && bC.bIP == bridgeIP } )) {
		bridgeConnectList[b].bInst =
			new bridgeOperationModule[bridgeConnectList[b].bType].Bridge( devBridge.length, bridgeID, bridgeIP,
			                                                              sendSmartThingsJSON, sentHubEvents );
		// create the operational bridge array element
		devBridge.push(bridgeConnectList[b].bInst);
		return true;
	}
	return false;
}

// handle newly-appearing bridges after startup, but only with existing authorization
function bridgeLateInitializers() {
	while (bridgeConnectList.length > bridgeInitCnt) {
		let b = bridgeInitCnt++;
		if (!bridgeOperationModuleRequire(bridgeConnectList[b].bType))	// require the corresponding bridge module
			bridgeConnectList[b].bType = null;
		else {
			if (bridgeCreate(b)) {
				log.info('%s Bridge %s #%i initializing', devBridge[b].bridgeBrand, devBridge[b].bridgeID, b);
				devBridge[b].initialize( persistAuthGet, function bLateInitComplete (err) {
					if (err) {
						log.warn('%s Bridge %s #%i did not initialize: ',
					             devBridge[b].bridgeBrand, devBridge[b].bridgeID, b, err.message);
					} else {
						devBridgeByID[devBridge[b].bridgeID] = devBridge[b]; // build the reverse lookup ID -to -bridge table
					}
				}.bind(this));
			}
		}
	}
}

// queue up a (synchronous) bridge initialize task
function taskBridgeInit(b, taskQ) {
	taskQ.push( function bInit (qcb) {
		if (!devBridge[b].initialized) {
			log.info('%s Bridge %s #%i initializing', devBridge[b].bridgeBrand, devBridge[b].bridgeID, b);
			devBridge[b].initialize( persistAuthGet, function bInitComplete (err) {
				var bInitOK = false;
				if (err) {
					log.warn('%s Bridge %s #%i did not initialize: ',
				             devBridge[b].bridgeBrand, devBridge[b].bridgeID, b, err.message);
					if (err.code == 'ENOENT' || err.code == 'ECONNREFUSED') {	// bridge not authorized
						if (bridgeAuthModuleRequire(devBridge[b].bridgeType)) {	// require the corresponding bridge authentication module
							var authInfo;
							if (devBridgeAuthInfo[b]) {	// if authorization info supplied at startup, try it ONCE
								authInfo = devBridgeAuthInfo[b];
								devBridgeAuthInfo[b] = null;
							} else	// try to acquire authorization info interactively
								authInfo = acquireBridgeAuthInfo(b, bridgeAuthModule[devBridge[b].bridgeType].authQueryFields());
							if (authInfo) {	// queue up a bridge authorization task
								taskBridgeAuth(b, authInfo, taskQ);
								return qcb();	// on to the next init task
							}
						} // else there doesn't seem to be any way to authorize the bridge, so skip it
					} // else some other initialization error, skip this bridge
				} else {
					bInitOK = true;
					devBridgeByID[devBridge[b].bridgeID] = devBridge[b]; // build the reverse lookup ID -to -bridge table
				}
				devBridgeEvents.emit(DBE_GOTINIT, b, bInitOK);	// bridge init succeeded (or not), report
				return qcb();	// on to the next init task
			}.bind(this));
		} else
			return qcb();	// on to the next init task
	}.bind(this));
}

// queue up a (synchronous) bridge authorization task
function taskBridgeAuth(b, authInfo, taskQ) {
	taskQ.push(function bAuth (qcb) {
		let userKey = Object.getOwnPropertyNames(authInfo).find( function(k) { return k.toLowerCase().startsWith('user') } );
		log.info('Generating %s authentication%s', devBridge[b].bridgeBrand, userKey?(' for ' + authInfo[userKey]):'');
		bridgeAuthModule[devBridge[b].bridgeType].authenticate(authInfo, function(err, bridgeAuthData) {
			if (err) {	// authentication did not succeed, go back and try again 'til manual abort
				log.warn('%s did not authenticate with specified authorization info', devBridge[b].bridgeBrand);
				// RETRY interactive entry of authorization info and authorization
				var	authInfo = acquireBridgeAuthInfo(b, bridgeAuthModule[devBridge[b].bridgeType].authQueryFields());
				if (authInfo)	// queue up another try of the bridge authorization task
					taskBridgeAuth(b, authInfo, taskQ);
				else	// if no auth info provided, abandon this bridge
					devBridgeEvents.emit(DBE_GOTINIT, b, false);
			} else {	// success: save the new authentication certificates and try try again to initialize
				persistAuthPut(devBridge[b].bridgeType, devBridge[b].bridgeID, bridgeAuthData);
				taskBridgeInit(b, taskQ);
			}
			return qcb();	// on to the next init task
		}.bind(this));
	}.bind(this));
}

// create and return an authInfo object whose keys are the values entered for the bridge's authQueryFields
function acquireBridgeAuthInfo(b, authQueryFields) {		// get authentication info from the user (synchronously)
	const bridgeName = devBridge[b].bridgeBrand + ' Bridge ' + devBridge[b].bridgeID;
	const sep = '---------------------';

	let authInfo = { };
	if (!authQueryFields) {
		let aQuery = userConsole.question( bridgeName + ': no authorization fields, press [Enter]');
		return false;
	}

	log.info(sep);
	let aQFLast  = authQueryFields.length - 1;

	for (let q = 0; q < aQFLast; q++) {
		if (authQueryFields[q]) {
			let aField = userConsole.question( bridgeName + ': [Enter] to skip, or enter ' + authQueryFields[q] + ': ' );
			if (aField) {
				authInfo[authQueryFields[q]] = aField;
			} else {	// no entry, abandon this query
				log.info(sep);
				return false;
			}
		}
	}
	if (authQueryFields[aQFLast]) {
		let aPassword = userConsole.questionNewPassword(
		    bridgeName + ': [Enter] to skip, or enter ' + authQueryFields[aQFLast] + ': ',
		    {limitMessage: 'The corresponding ' + devBridge[b].bridgeBrand + ' ' + authQueryFields[aQFLast],
			 min:1,
			 confirmMessage:'Re-enter the same ' + authQueryFields[aQFLast] + ' to confirm: '} );
		if (aPassword) {
			authInfo[authQueryFields[aQFLast]] = aPassword;
		} else {		// if no (required) password, abandon this query
			log.info(sep);
			return false;
		}
	}
	log.info(sep);
	// all necessary info gathered from the user, back to try authorization again
	return authInfo;
}

// v 2.0.0			2018.05.10 1200Z	wjh  Bill Hinkle (github billhinkle)
//					refactored into separate module for lutron-specific discovery to be used as a plug-in
// v 2.0.0-beta5	2018.09.20			tweaked discover() to fix variable persistence problem
'use strict';
module.exports = {
	discover
};

const ip = require('ip');
// const dns = require('dns');
const mDNSHandler = require('../lib/bonjour-up')();

const bridgeBrand = 'Lutron';
const bridgeType = 'lutron';
function generateBridgeID(srcString) {	// generate a unique bridge ID from host:'lutron-hexSN.local'
	return srcString.replace(/lutron-/i, '').replace(/\.local/i,'').toUpperCase();	// 'lutron-hexSN.local'
}

// this discover function is specific to Lutron bridges
function discover(discovery, logger, bridgeFoundCallback) {
	// discovery = boolean stop/run, logger = console.log-like logger, 
	// bridgeFoundCallback(bridgeBrand,bridgeID,bridgeIP,isupdate)
	if (!logger)
		logger = function() {};
	if (typeof discover.mdnsFoundBridge === 'undefined') {
		discover.mdnsFoundBridge = null;
		discover.bridgeRoster = {};
	}

	if (discovery) {
		 discover.mdnsFoundBridge = mDNSHandler.find({ type: bridgeType }, function sniffBridges(bridgeService, isupdate) {
			var bridgeID = generateBridgeID(bridgeService.host);
			var bridgeIP = bridgeService.addresses.find( function(addr) {
				return ip.isV4Format(addr);
			});
			if (!bridgeIP)
				bridgeIP = bridgeService.addresses[0];

			if (discover.mdnsFoundBridge.services.length != Object.keys(discover.bridgeRoster).length ||
			    discover.bridgeRoster[bridgeID] != bridgeIP) {
				discover.bridgeRoster[bridgeID] = bridgeIP;

				logger('...%s Bridge mDNS %s / now %d service(s): %s', bridgeBrand,
				       (isupdate) ? 'updated' : 'found', discover.mdnsFoundBridge.services.length, (new Date()));
				logger('...%s Bridge mDNS Host: %s IP: %s', bridgeBrand, bridgeService.host, bridgeIP);
				if (!isupdate) {
					logger('...%s Bridge mDNS Name: %s', bridgeBrand, bridgeService.name);
					logger('...%s Bridge mDNS FQDN: %s', bridgeBrand, bridgeService.fqdn);
					logger('...%s Bridge mDNS MAC: %s', bridgeBrand, bridgeService.txt.macaddr);
//					logger('...%s Bridge mDNS TTL (sec): ' + bridgeService.ttl, bridgeBrand);
					// note: it is only a usable Lutron bridge if
					// mdnsLutronBridge.service[0].txt.fw_status == 'Noupdate'
					// mdnsLutronBridge.service[0].txt.nw_status == '11:InternetWorking'
					// mdnsLutronBridge.service[0].txt.st_status == 'good'
					// else flush, fall back and retry in a while
				}
			}
			bridgeFoundCallback(bridgeBrand, bridgeID, bridgeIP, isupdate);
			return;
		});
		discover.mdnsFoundBridge.on('down', function downBridges(bridgeService) {
			var bridgeID = generateBridgeID(bridgeService.host);
			var bridgeIP = bridgeService.addresses.find( function(addr) {
				return ip.isV4Format(addr);
			});
			if (!bridgeIP)
				bridgeIP = bridgeService.addresses[0];
			logger('...%s Bridge mDNS down / now %d service(s): %s', bridgeBrand, discover.mdnsFoundBridge.services.length, (new Date()));
			logger('...%s Bridge mDNS IP: ' + bridgeIP, bridgeBrand);
			logger('...%s Bridge mDNS Name: ' + bridgeService.name, bridgeBrand);
			logger('...%s Bridge mDNS FQDN: ' + bridgeService.fqdn, bridgeBrand);
			logger('...%s Bridge mDNS Host: ' + bridgeService.host, bridgeBrand);
			delete discover.bridgeRoster[bridgeID];
			return;
		});
	} else if (discover.mdnsFoundBridge) {
		discover.mdnsFoundBridge.stop();
		discover.mdnsFoundBridge = null;
		discover.bridgeRoster = {};
	}
}

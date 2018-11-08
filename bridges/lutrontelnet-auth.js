// v 1.0.0	2018.10.08 1200Z			wjh  Bill Hinkle (github billhinkle)
//					for Lutron integration protocol (LIP) telnet-only authentication to be used as a plug-in
'use strict';
module.exports = {
	authenticate,
	authQueryFields
};

// const assert = require('assert');
const logAuth = require('loglevel');
logAuth.setLevel('info')

const bridgeType = 'lutrontelnet';
var options = {};		// command-line options

// command-line options relevant to authorization modules are as 'bridgeType=string' (may be multiple)
let opttag = bridgeType + '=';
for (let a=2; a < process.argv.length; a++) {
	if (process.argv[a].startsWith(opttag)) {
		let opt = process.argv[a].substr(opttag.length).toLowerCase();
		options[opt] = true;
	}
}

// set option higher-detail logging per CLI options trace/debug
if (options.trace) {
	logAuth.setLevel('trace');
} else if (options.debug) {
	logAuth.setLevel('debug');
}

// -------------------------

function authQueryFields() {
	return [ 'login', 'password' ];	// describes order and prompt/key name of required fields; last element is ** password or ''
}

function authenticate(authInfo, authCallback) { // authInfo={login:userID,password:pw},authCallback(err, lutronTelnetAuth)
/*
	if (!authInfo.login)
		authInfo.login = 'lutron';
	if (!authInfo.password)
		authInfo.password = 'integration';
*/
	if (!authInfo.login || !authInfo.password) {
		logAuth.error('Lutron Telnet authentication requires: %o', authQueryFields());
		authCallback('errorUserAuth');
		return;
	}

	authCallback(0, authInfo);
	return;
}


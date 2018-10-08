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
// v 1.1.0  		lutronpro (original)		nate schwartz (github njscwartz)  with ICS license
// v 2.0.0+			 lutronpi (forked)	wjh Bill hinkle (github billhinkle)
// v 2.0.0			2018.05.10 1200Z	wjh  Bill Hinkle (github billhinkle)
//	refactored into separate modules for supervisor, discovery, authentication and bridge functions, so other bridge handlers can be plugged in
//  see lutronpi.js supervisory module for additional/initial 2.0.0 revision list
// v 2.0.0.beta-6	2018.09.26			wjh Bill Hinkle (github billhinkle)
//					corrected help message prompting required auth fields upon error
'use strict';
module.exports = {
	authenticate,
	authQueryFields
};

// const assert = require('assert');
const logAuth = require('loglevel');
logAuth.setLevel('info')

const request = require('request');
// const fs = require('fs');

const forge = require('node-forge');
const URLSearchParams = require('url-search-params');

const bridgeType = 'lutron';
var options = {};		// command-line options

// command-line options relevant to authorization modules are as 'bridgeType=string' (may be multiple)
let opttag = bridgeType + '=';
for (let a=2; a < process.argv.length; a++) {
	if (process.argv[a].startsWith(opttag)) {
		let opt = process.argv[a].substr(opttag.length).toLowerCase();
		options[opt] = true;
	}
}

// set option higher-detail logging per CLI optiosn trace/debug
if (options.trace) {
	logAuth.setLevel('trace');
} else if (options.debug) {
	logAuth.setLevel('debug');
}

// -------------------------

function authQueryFields() {
	return [ 'user', 'password' ];	// describes order and prompt/key name of required fields; last element is ** password or ''
}

function authenticate(authInfo, authCallback) { // authInfo={user:userID,password:pw},authCallback(err, lutronAuth)
	if (!authInfo.user || !authInfo.password) {
		logAuth.error('Lutron authentication requires: %o', authQueryFields());
		authCallback('errorUserAuth');
		return;
	}
	const user = authInfo.user;
	const pw = authInfo.password;

	const CLIENT_ID =
		"e001a4471eb6152b7b3f35e549905fd8589dfcf57eb680b6fb37f20878c28e5a";
	const CLIENT_SECRET =
		"b07fee362538d6df3b129dc3026a72d27e1005a3d1e5839eed5ed18c63a89b27";
	const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

	// only one authenticated Lutron bridge is permitted per account
	const NOAUTH = null;

	var lutronAuth = {user: user, privateKey: null, appCert: null, localCert: null};
	var accessToken;
	var jsonKey;
	var client;
	var authenticityToken;
	var cookie;
	var keys;
	var code;

	var self = this;

	var _Authenticate = function() {

//		try {	// temporary legacy format translation
//			fs.statSync('appCert');
//			fs.statSync('localCert');
//			fs.statSync('privateKey');
//
//			logAuth.info('appCert/localCert/privateKey all exist! YEAH!!');
//
//			lutronAuth.privateKey = fs.readFileSync('privateKey');
//			lutronAuth.appCert = JSON.parse(fs.readFileSync('appCert'));		//remote_signs_app_certificate
//			lutronAuth.localCert = JSON.parse(fs.readFileSync('localCert'));	//local_signs_remote_certificate
//
//			authCallback(0, lutronAuth);
//			return;
//		} catch (e) {
//			logAuth.info('No certificates; will attempt to generate them');
			logAuth.info('Key generation may take a while...');
//		}
		forge.pki.rsa.generateKeyPair(2048, function(error, keypair) {
			logAuth.trace('keys callback');
			if (error) {
				logAuth.error('There was an error generating the keys!', error);
				authCallback('errorKeyGen');
				return;
			};
			keys = keypair;
			startCodeFetch();
		});
	}();

	function startCodeFetch() {

		request.get({
			headers: {
				'content-type': 'application/x-www-form-urlencoded'
			},
			followAllRedirects: false,
			family: 4,
			url: 'https:\/\/device-login.lutron.com/users/sign_in',
		}, function(error, response, body) {
			if (error) {
				logAuth.error('There was an error accessing Lutron sign_in!', error);
				authCallback('errorLutronSignIn');
				return;
			};
			var s = body.indexOf('name="authenticity_token" value="');
			authenticityToken = body.substr(s + 33, 100).split('"')[0].trim();
			cookie = response.headers['set-cookie'][0].trim();
			logAuth.debug(authenticityToken);
			callSignIn();
		});
	}

	function callSignIn() {
		var paramsObject = {
			utf8: "âœ“",
			authenticity_token: authenticityToken,
			'user[email]': user,
			'user[password]': pw,
			commit: "Sign In"
		};
		var params = new URLSearchParams(paramsObject).toString();
		logAuth.debug(params);
		request.post({
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'Cookie': cookie
			},
			url: 'https:\/\/device-login.lutron.com/users/sign_in?' + params,
			body: "",
		}, function(error, response, body) {
			if (error) {
				logAuth.error('There was an error getting the token!', error);
				authCallback('errorGetToken');
				return;
			};
			cookie = response.headers['set-cookie'][0].trim();
			logAuth.debug(authenticityToken);
			getCode();
		});
	}

	function getCode() {

		logAuth.trace('getCode called');
		request.get({
			headers: {
				'Cookie': cookie
			},
			url: 'https:\/\/device-login.lutron.com/oauth/authorize?redirect_uri=' +
				encodeURI(REDIRECT_URI) + '&client_id=' + encodeURI(CLIENT_ID) +
				'&response_type=code',
			followAllRedirects: true,
		}, function(error, response, body) {
			if (error) {
				logAuth.error('There was an error getting the code!', error);
				authCallback('errorGetCode');
				return;
			};
			logAuth.debug(authenticityToken);
			var s = body.indexOf('authorization_code');
			logAuth.debug(s);
			if (s == -1) {
				logAuth.error('No code, try again');
				logAuth.error('Failed to authorize user %s', user);
				authCallback('errorUserAuth');
			}
			else {
				code = body.substr(s + 20, 80)
					.split('<')[0];
				logAuth.debug('the code is ' + code);
				logAuth.trace(body);
				cookie = response.headers['set-cookie'][0].trim();
				getCSR();
			}
		});
	}

	function getCSR() {

		logAuth.trace('in get CSR');
		var csr = forge.pki.createCertificationRequest();

		// fill the required fields
		csr.publicKey = keys.publicKey;

		// use your own attributes here, or supply a csr (check the docs)
		var attrs = [{
			shortName: 'CN',
			value: 'Lutron Caseta App'
	}, {
			shortName: 'C',
			value: 'US'
	}, {
			shortName: 'ST',
			value: 'Pennsylvania'
	}, {
			shortName: 'L',
			value: 'Coopersburg'
	}, {
			shortName: 'O',
			value: 'Lutron Electronics Co., Inc.'
	}];

		// here we set subject and issuer as the same one
		csr.setSubject(attrs);

		// the actual certificate signing
		csr.sign(keys.privateKey);
		logAuth.debug(csr);
		var verified = csr.verify();
		// now convert the Forge certificate to PEM format
		var pem = forge.pki.certificationRequestToPem(csr);
		logAuth.debug(pem);

		var strippedPem = pem.replace(/\r/g, "");
		jsonKey = {
			"remote_signs_app_certificate_signing_request": strippedPem
		};
		logAuth.debug(JSON.stringify(jsonKey));
		getAccessToken();
	}

	function getAccessToken() {

		logAuth.trace('in get token');
		logAuth.debug('the code is ' + code);
		var paramsObject = {
			redirect_uri: REDIRECT_URI,
			'client_id': CLIENT_ID,
			client_secret: CLIENT_SECRET,
			'code': code,
			'grant_type': 'authorization_code'
		};
		var params = new URLSearchParams(paramsObject).toString();

		request.post({
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'Cookie': cookie
			},
			url: 'https:\/\/device-login.lutron.com/oauth/token',
			body: params,
		}, function(error, response, body) {
			if (error) {
				logAuth.error('There was an error obtaining the access token!', error);
				authCallback('errorGetOauthToken');
				return;
			};
			var jsonObject = JSON.parse(body);
			accessToken = jsonObject.access_token;
			logAuth.debug(accessToken);
			logAuth.debug(body);
			getCerts();
		});
	}

	function getCerts() {

		logAuth.trace('in get certs');
		request.post({
			headers: {
				'content-type': 'application/json',
				'X-DeviceType': 'Caseta,RA2Select',
				'Authorization': 'Bearer ' + accessToken
			},
			url: 'https:\/\/device-login.lutron.com/api/v1/remotepairing/application/user',
			body: JSON.stringify(jsonKey)
		}, function(error, response, body) {
			if (error) {
				logAuth.error('There was an error generating the certificates!', error);
				authCallback('errorCertGen');
				return;
			};
			var jsonObject = JSON.parse(body);
			lutronAuth.appCert = jsonObject.remote_signs_app_certificate;
			lutronAuth.localCert = jsonObject.local_signs_remote_certificate;
			lutronAuth.privateKey = forge.pki.privateKeyToPem(keys.privateKey);

			logAuth.debug(lutronAuth.privateKey);
			logAuth.debug(lutronAuth.appCert);
			logAuth.debug(lutronAuth.localCert);

			authCallback(0, lutronAuth);
			return;
		});
	}
}

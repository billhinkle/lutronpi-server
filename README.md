# lutronpi-server
LutronPi Server connecting Lutron bridges to SmartThings hub - Node.js

LutronPi 2.x Server is derived from Nate Schwartz' LutronPro 1.x package for Node.js and SmartThings.  
Due to essential divergences, LutronPi Server is _not backwards compatible_ with Nate's earlier work,
and will work _only_ with the corresponding LutronPi device handlers and service manager running
on the SmartThings platform.  
(See **FORM #2**, below.  This application's SmartThings namespace is: `lutronpi`)

### FUNCTION:
The LutronPi application serves to connect Lutron lighting bridges (SmartBridge, SmartBridge Pro,
RA2/Select repeater) to a local hub of the Samsung SmartThings home automation platform. There is an
'official' Lutron-to-SmartThings integration, which unfortunately does not integrate the Lutron Pico
remote button fobs into SmartThings.  LutronPi _does_ connect the Pico buttons to SmartThings and allows those
buttons to trigger SmartThings actions as well as native Lutron actions.

N.B. Pico button integration only works when the Picos are paired to a Lutron SmartBridge Pro or RA2/Select
repeater, not to a standard retail SmartBridge.  Dimmer fading also only works for dimmers on such bridges.

### FORM:
The LutronPi application comprises two elements:
  1. A server application running under Node.js on an independent computer (e.g. a Raspberry Pi or the like,
  or a desktop computer, or laptop, or potentially a NAS drive, etc.).  The server must be on the same local
  Ethernet subnet as the Lutron bridge(s) and the SmartThings hub.  
  See: https://github.com/billhinkle/lutronpi-server  
  2. A SmartThings "SmartApp" service manager application, along with its associated device handlers. These
  Groovy modules all run on the Samsung SmartThings platform, both local to the hub and in "the cloud."  
  See: https://github.com/billhinkle/lutronpi-smartthings  

### INSTALLATION:
  * Install Node.js for your host computer platform; see https://nodejs.org/en/download/
  * Make a directory/folder for LutronPi Server; e.g. `mkdir lutronpi`
  * Copy the contents of the lutronpi-server GitHub repository 
    https://github.com/billhinkle/lutronpi-server
	into that directory/folder, with all files and the subdirectory structure (`bridges/` and `lib/`).  
	You may download the repository as a ZIP file and extract it within that directory, or use  
	`git clone https://github.com/billhinkle/lutronpi-server lutronpi`  
	or create the subdirectories and copy the files manually, or any other method you prefer.  The
	installation directory should now contain  
	`package.json`, `lutronpi.js`, `LutronPiServer.js`, some other files, and subdirectories `bridges`
	and `lib`, both of which contain additional files.
  * From within that directory (i.e. `cd lutronpi` first), run  
    `npm install`  
	This command to the Node Package Manager (npm) will download and install the necessary Node.js
	modules for LutronPi Server, into a `node_modules` subdirectory.  If you have some more elaborate
	Node.js setup, install accordingly.
	
 It is most convenient to install and start the SmartThings SmartApp service manager and device handlers
 before running the LutronPi server on your node.js platform.

 N.B. Neither LutronPi Server nor Node.js provides automatic restart of the server application when its host
 computer shuts down, power-fails, reboots, or otherwise restarts.  This restart capability must be set up
 separately on your host platform.  The PM2 process manager is one of several viable tools for this purpose
 (see https://www.npmjs.com/package/pm2 ), another is Forever (see https://www.npmjs.com/package/forever ).

 ### OPERATION:
 Assuming installation in a `lutronpi` directory,  
 `node lutronpi/lutronpi`   will start the LutronPi Server with automatic Lutron and SmartThings discovery  
 `node lutronpi/LutronPiServer`  will start the LutronPi Server with customized Lutron/St specifications
 
 Bridge authentication .key files will be stored in (and expected in) the current directory from which
 the application was started, regardless of where the LutronPi Server files are installed.
 Running `lutronpi.js` directly, as above, will provide automatic discovery of Lutron bridges and the
 SmartThings hub.   If (Bonjour/mDNS) discovery does not work on your platform, modify `LutronPiServer.js`
 as required for manual specification of your bridge and/or hub connections (details within that file).
 
### UPDATES (v 2.0.0):
Beyond the original LutronPro 1.x package and its support of Lutron dimmers, switches and 3BRL Picos:
  * Connects to multiple Lutron bridges simultaneously, including:
    standard SmartBridge, SmartBridge Pro, & RA2/Select repeater
  * Supports all (almost all?) Pico models: 2B, 2BRL, 3B, 3BRL, 4B
  * Supports Lutron shades (only partially tested, feedback solicited!)
  * Interactive authentication of Lutron bridges, so user/password info need not be stored in the clear
  * Automatically enable Telnet interface on Pro and RA2/Select to allow Pico interface to SmartThings
  * Maintains and automatically restores connections to bridges and hub over a variety of communications
    disruptions, including temporary disconnections, loss of bridge/hub power, change of IP address
  * Automatically discovers Lutron bridges and SmartThings hub on the local network, with manual overrides
  * Notification to SmartThings service manager of server restart and/or change of IP address, with
    automatic restoration of configurations and device status refresh (e.g. light levels)
  * Pico button handling modified to reliably handle multiple simultaneous Pico events
  * All Pico configuration is maintained in the SmartThings service manager and Pico device handlers;
    no configuration is required at the (node.js) server for push-to-hold times, hold-to-repeat, or timeouts.
  * Pico buttons transmit press and release events to SmartThings in addition to push and hold events
  * Pico buttons will (optionally) time out push/hold after 6 seconds
  * SmartThings can (optionally) trigger Pico-associated events on the Lutron bridge(s)
  * SmartThings representation of Lutron scenes can also trigger other SmartThings events
  * Dimmers now support level raise/lower commands from SmartThings
  * Dimmers now support fade-over-time (on and/or off) - only on Pro and RA2/Select
  * Supervisory and bridge-related functions divided into separate modules and heavily refactored
  * Infrastructure for plug-in modules to allow connection of other 'bridge' types alongside Lutron

### A WARNING!
Lutron has been known to change their bridge authentication scheme without warning or recourse.  If
that happens in the future, LutronPi operation may be disrupted until some smart person figures out the
new authentication scheme, and any necessary software changes are made to this package.

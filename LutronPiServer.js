// illustrates how to start the LutronPi server with various bridge options
// Lutron bridge ID is the serial number printed on the bottom of the unit just above the barcode
const mainHomeDir = process.mainModule.paths[0].split('node_modules')[0].slice(0, -1);
var lutronpi = require(mainHomeDir + '/' + 'lutronpi');
// Enter your Bridge specifications (nothing -> Lutron bridge discovery only

lutronpi.startup( );	// with no parameters == Lutron bridge discovery; SmartThings hub discovery
						// OR you can just run node lutronpi" directly... same thing.

// with parameters: bridge specification; SmartThings hub network address
// lutronpi.startup( BRIDGE, SMARTTHINGS_IP );

// Lutron bridge discovery, ST hub IP specified
// lutronpi.startup( null, 192.168.0.100 );

// one Lutron bridge specified, authentication user/password will be requested if needed; ST hub discovery
// lutronpi.startup( {{type:"Lutron",id:"01ABCDEF", ip:"192.168.0.101" } );

// one Lutron bridge specified with authentication user/password (not recommended!) ; ST hub discovery
// lutronpi.startup( {{type:"Lutron",id:"01ABCDEF", ip:"192.168.0.101", auth:{user:"fred@wilma.com", password:"yabadabadoo"}} );

// two Lutron bridges specified; ST hub network host name specified
// const BRIDGE = [{type:"Lutron",id:"01ABCDEF", ip:"192.168.0.101"},{type:"lutron",id:"01FEDCBA",ip:"192.168.0.102"}];
// const SMARTTHINGS_IP = 'st-12EC4A00000230ED';
// lutronpi.startup( BRIDGE, SMARTTHINGS_IP );

// discover Lutron bridges but ignore the one with serial number 01FEDCBA; SmartThings hub discovery
// const BRIDGE = [{type:"Lutron"},{id:"01FEDCBA"}];
// lutronpi.startup( BRIDGE );

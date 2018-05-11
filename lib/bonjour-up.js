// 2018.04.30	wjh	 Bill Hinkle (github billhinkle)
// monkeypatch for watson bonjour
// look for // +mp & // -mp tags
//   add trailing update flag parameter on 'up' emitter callback: false=new service found; true=update of known service
//   add code to recognize a flush mdns packet for a known service as an update of that service
//   add detection of spurious goodbye packets (wrong bridge for specified service) and ignore them
'use strict'

var serviceName = require('multicast-dns-service-types')
var dnsEqual = require('dns-equal')

var Bonjour = require('bonjour')

module.exports = Bonjour

// +mp
Bonjour.prototype.virginFind = Bonjour.prototype.find
Bonjour.prototype.find = bonjourFindUpdate

function bonjourFindUpdate (opts, onup) {

  var aBrowser = this.virginFind (opts, onup)
  if (!aBrowser._updateService) {
    aBrowser.stop();	// stop the unpatched browser and patch it up

    aBrowser.start = bonjourBrowserStart.bind(aBrowser)
    aBrowser._addService = bonjourBrowser_addService.bind(aBrowser)
    aBrowser._updateService = bonjourBrowser_updateService.bind(aBrowser)
    aBrowser.start();	// restart the patched browser
  }
  return aBrowser;
}
// -mp

// +mp  Patched start() method
function bonjourBrowserStart () {
// -mp
  if (this._onresponse) return

  var self = this

  // List of names for the browser to listen for. In a normal search this will
  // be the primary name stored on the browser. In case of a wildcard search
  // the names will be determined at runtime as responses come in.
  var nameMap = {}
  if (!this._wildcard) nameMap[this._name] = true

  this._onresponse = function (packet, rinfo) {

   if (self._wildcard) {
      packet.answers.forEach(function (answer) {
        if (answer.type !== 'PTR' || answer.name !== self._name || answer.name in nameMap) return
        nameMap[answer.data] = true
        self._mdns.query(answer.data, 'PTR')
      })
    }

    Object.keys(nameMap).forEach(function (name) {
      // unregister all services shutting down
// +mp ignore spurious goodbye packets (wrong bridge for specified service)
      goodbyes(name, packet).forEach(function(gsn,igsn,agsn) {
		if (self.services.find(function(ms,ims,ams) {
			return dnsEqual(ms.fqdn, gsn) && ms.addresses.some(function(a) { return dnsEqual(a, rinfo.address) } )
		}))
			self._removeService.bind(self)(gsn)
      })
// -mp
      // register all new services
      var matches = buildServicesFor(name, packet, self._txt, rinfo)
      if (matches.length === 0) return

      matches.forEach(function (service) {
// +mp treat flush-flagged packets as updates rather than ignore them entirely
        if (self._serviceMap[service.fqdn]) {
          // mDNS cache flush is actually supposed to be a lot more complex than this!
          if (service.flush)  // a flush packet for an existing service indicates an update, e.g. possible IP change
            self._updateService(service)
          return // ignore or update already registered services
        }
// -mp
        self._addService(service)
      })
    })
  }

  this._mdns.on('response', this._onresponse)
  this.update()
}

// +mp ensure update flag is false for newly-found 'up' services
function bonjourBrowser_addService (service) {
// -mp
  this.services.push(service)
  this._serviceMap[service.fqdn] = true
// +mp
  this.emit('up', service, false)  //newly up, not update
// -mp
}

// +mp update a known service upon receipt of a flush-flagged packet
function bonjourBrowser_updateService (service) {
  var xservice, index
  this.services.some(function (s, i) {
    if (dnsEqual(s.fqdn, service.fqdn)) {
      xservice = s
      index = i
      return true
    }
  })
  if (!xservice) return
  this.services.splice(index, 1, service)
  this.emit('up', service, true) //updated
}
// -mp

// PTR records with a TTL of 0 is considered a "goodbye" announcement. I.e. a
// DNS response broadcasted when a service shuts down in order to let the
// network know that the service is no longer going to be available.
//
// For more info see:
// https://tools.ietf.org/html/rfc6762#section-8.4
//
// This function returns an array of all resource records considered a goodbye
// record
function goodbyes (name, packet) {
  return packet.answers.concat(packet.additionals)
    .filter(function (rr) {
      return rr.type === 'PTR' && rr.ttl === 0 && dnsEqual(rr.name, name)
    })
    .map(function (rr) {
      return rr.data
    })
}

function buildServicesFor (name, packet, txt, referer) {
  var records = packet.answers.concat(packet.additionals).filter(function (rr) {
    return rr.ttl > 0 // ignore goodbye messages
  })

  return records
    .filter(function (rr) {
      return rr.type === 'PTR' && dnsEqual(rr.name, name)
    })
    .map(function (ptr) {
      var service = {
        addresses: []
      }

      records
        .filter(function (rr) {
          return (rr.type === 'SRV' || rr.type === 'TXT') && dnsEqual(rr.name, ptr.data)
        })
        .forEach(function (rr) {
          if (rr.type === 'SRV') {
            var parts = rr.name.split('.')
            var name = parts[0]
            var types = serviceName.parse(parts.slice(1, -1).join('.'))
            service.name = name
            service.fqdn = rr.name
            service.host = rr.data.target
            service.referer = referer
            service.port = rr.data.port
// +mp added ttl  & flush cache flag to service object
            service.ttl = rr.ttl
            service.flush = rr.flush
// -mp
            service.type = types.name
            service.protocol = types.protocol
            service.subtypes = types.subtypes
          } else if (rr.type === 'TXT') {
            service.rawTxt = rr.data
            service.txt = txt.decode(rr.data)
          }
        })

      if (!service.name) return

      records
        .filter(function (rr) {
          return (rr.type === 'A' || rr.type === 'AAAA') && dnsEqual(rr.name, service.host)
        })
        .forEach(function (rr) {
          service.addresses.push(rr.data)
        })

      return service
    })
    .filter(function (rr) {
      return !!rr
    })
}

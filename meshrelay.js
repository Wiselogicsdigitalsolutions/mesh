/**
* @description MeshCentral connection relay module
* @author Ylian Saint-Hilaire
* @copyright Intel Corporation 2018
* @license Apache-2.0
* @version v0.0.1
*/

module.exports.CreateMeshRelay = function (parent, ws, req, domain) {
    var obj = {};
    obj.ws = ws;
    obj.req = req;
    obj.peer = null;
    obj.parent = parent;
    obj.id = req.query.id;
    obj.remoteaddr = obj.ws._socket.remoteAddress;
    obj.domain = domain;
    if (obj.remoteaddr.startsWith('::ffff:')) { obj.remoteaddr = obj.remoteaddr.substring(7); }

    // Disconnect this agent
    obj.close = function (arg) {
        if ((arg == 1) || (arg == null)) { try { obj.ws.close(); obj.parent.parent.debug(1, 'Relay: Soft disconnect (' + obj.remoteaddr + ')'); } catch (e) { console.log(e); } } // Soft close, close the websocket
        if (arg == 2) { try { obj.ws._socket._parent.end(); obj.parent.parent.debug(1, 'Relay: Hard disconnect (' + obj.remoteaddr + ')'); } catch (e) { console.log(e); } } // Hard close, close the TCP socket
    }

    obj.sendAgentMessage = function (command, userid, domainid) {
        if (command.nodeid == null) return false;
        var user = obj.parent.users[userid];
        if (user == null) return false;
        var splitnodeid = command.nodeid.split('/');
        // Check that we are in the same domain and the user has rights over this node.
        if ((splitnodeid[0] == 'node') && (splitnodeid[1] == domainid)) {
            // Get the user object
            // See if the node is connected
            var agent = obj.parent.wsagents[command.nodeid];
            if (agent != null) {
                // Check if we have permission to send a message to that node
                var rights = user.links[agent.dbMeshKey];
                if (rights != null || ((rights & 16) != 0)) { // TODO: 16 is console permission, may need more gradular permission checking
                    command.sessionid = ws.sessionId;   // Set the session id, required for responses.
                    command.rights = rights.rights;     // Add user rights flags to the message
                    delete command.nodeid;              // Remove the nodeid since it's implyed.
                    agent.send(JSON.stringify(command));
                    return true;
                }
            } else {
                // Check if a peer server is connected to this agent
                var routing = obj.parent.parent.GetRoutingServerId(command.nodeid, 1); // 1 = MeshAgent routing type
                if (routing != null) {
                    // Check if we have permission to send a message to that node
                    var rights = user.links[routing.meshid];
                    if (rights != null || ((rights & 16) != 0)) { // TODO: 16 is console permission, may need more gradular permission checking
                        command.fromSessionid = ws.sessionId;   // Set the session id, required for responses.
                        command.rights = rights.rights;         // Add user rights flags to the message
                        obj.parent.parent.multiServer.DispatchMessageSingleServer(command, routing.serverid);
                        return true;
                    }
                }
            }
        }
        return false;
    }

    if (req.query.auth == null) {
        // Use ExpressJS session, check if this session is a logged in user, at least one of the two connections will need to be authenticated.
        try { if ((req.session) && (req.session.userid) || (req.session.domainid == obj.domain.id)) { obj.authenticated = true; } } catch (e) { }
        if ((obj.authenticated != true) && (req.query.user != null) && (req.query.pass != null)) {
            // Check user authentication
            obj.parent.authenticate(req.query.user, req.query.pass, obj.domain, function (err, userid, passhint) {
                if (userid != null) {
                    obj.authenticated = true;
                    // Check if we have agent routing instructions, process this here.
                    if ((req.query.nodeid != null) && (req.query.tcpport != null)) {
                        if (obj.id == undefined) { obj.id = ('' + Math.random()).substring(2); } // If there is no connection id, generate one.
                        var command = { nodeid: req.query.nodeid, action: 'msg', type: 'tunnel', value: '*/meshrelay.ashx?id=' + obj.id, tcpport: req.query.tcpport, tcpaddr: ((req.query.tcpaddr == null) ? '127.0.0.1' : req.query.tcpaddr) };
                        if (obj.sendAgentMessage(command, userid, obj.domain.id) == false) { obj.id = null; obj.parent.parent.debug(1, 'Relay: Unable to contact this agent (' + obj.remoteaddr + ')'); }
                    }
                } else {
                    obj.parent.parent.debug(1, 'Relay: User authentication failed (' + obj.remoteaddr + ')');
                    obj.ws.send('error:Authentication failed');
                }
                performRelay();
            });
        } else {
            performRelay();
        }
    } else {
        // Get the session from the cookie
        var cookie = obj.parent.parent.decodeCookie(req.query.auth);
        if (cookie != null) {
            obj.authenticated = true;
            if (cookie.tcpport != null) {
                // This cookie has agent routing instructions, process this here.
                if (obj.id == undefined) { obj.id = ('' + Math.random()).substring(2); } // If there is no connection id, generate one.
                // Send connection request to agent
                var command = { nodeid: cookie.nodeid, action: 'msg', type: 'tunnel', value: '*/meshrelay.ashx?id=' + obj.id, tcpport: cookie.tcpport, tcpaddr: cookie.tcpaddr };
                if (obj.sendAgentMessage(command, cookie.userid, cookie.domainid) == false) { obj.id = null; obj.parent.parent.debug(1, 'Relay: Unable to contact this agent (' + obj.remoteaddr + ')'); }
            }
        } else {
            obj.id = null;
            obj.parent.parent.debug(1, 'Relay: invalid cookie (' + obj.remoteaddr + ')');
            obj.ws.send('error:Invalid cookie');
        }
        performRelay();
    }

    function performRelay() {
        if (obj.id == null) { try { obj.close(); } catch (e) { } return null; } // Attempt to connect without id, drop this.
        ws._socket.setKeepAlive(true, 240000); // Set TCP keep alive

        // Validate that the id is valid, we only need to do this on non-authenticated sessions.
        // TODO: Figure out when this needs to be done.
        /*
        if (!parent.args.notls) {
            // Check the identifier, if running without TLS, skip this.
            var ids = obj.id.split(':');
            if (ids.length != 3) { obj.ws.close(); obj.id = null; return null; } // Invalid ID, drop this.
            if (parent.crypto.createHmac('SHA384', parent.relayRandom).update(ids[0] + ':' + ids[1]).digest('hex') != ids[2]) { obj.ws.close(); obj.id = null; return null; } // Invalid HMAC, drop this.
            if ((Date.now() - parseInt(ids[1])) > 120000) { obj.ws.close(); obj.id = null; return null; } // Expired time, drop this.
            obj.id = ids[0];
        }
        */

        // Check the peer connection status
        {
            var relayinfo = parent.wsrelays[obj.id];
            if (relayinfo) {
                if (relayinfo.state == 1) {
                    // Check that at least one connection is authenticated
                    if ((obj.authenticated != true) && (relayinfo.peer1.authenticated != true)) {
                        obj.id = null;
                        obj.ws.close();
                        obj.parent.parent.debug(1, 'Relay without-auth: ' + obj.id + ' (' + obj.remoteaddr + ')');
                        return null;
                    }

                    // Connect to peer
                    obj.peer = relayinfo.peer1;
                    obj.peer.peer = obj;
                    relayinfo.peer2 = obj;
                    relayinfo.state = 2;
                    obj.ws.send('c'); // Send connect to both peers
                    relayinfo.peer1.ws.send('c');
                    relayinfo.peer1.ws.resume(); // Release the traffic

                    relayinfo.peer1.ws.peer = relayinfo.peer2.ws;
                    relayinfo.peer2.ws.peer = relayinfo.peer1.ws;

                    obj.parent.parent.debug(1, 'Relay connected: ' + obj.id + ' (' + obj.remoteaddr + ' --> ' + obj.peer.remoteaddr + ')');
                } else {
                    // Connected already, drop (TODO: maybe we should re-connect?)
                    obj.id = null;
                    obj.ws.close();
                    obj.parent.parent.debug(1, 'Relay duplicate: ' + obj.id + ' (' + obj.remoteaddr + ')');
                    return null;
                }
            } else {
                // Wait for other relay connection
                ws.pause(); // Hold traffic until the other connection
                parent.wsrelays[obj.id] = { peer1: obj, state: 1 };
                obj.parent.parent.debug(1, 'Relay holding: ' + obj.id + ' (' + obj.remoteaddr + ') ' + (obj.authenticated?'Authenticated':'') );

                // Check if a peer server has this connection
                if (parent.parent.multiServer != null) {
                    var rsession = obj.parent.wsPeerRelays[obj.id];
                    if ((rsession != null) && (rsession.serverId > obj.parent.parent.serverId)) {
                        // We must initiate the connection to the peer
                        parent.parent.multiServer.createPeerRelay(ws, req, rsession.serverId, req.session.userid);
                        delete parent.wsrelays[obj.id];
                    } else {
                        // Send message to other peers that we have this connection
                        parent.parent.multiServer.DispatchMessage(JSON.stringify({ action: 'relay', id: obj.id }));
                    }
                }
            }
        }
    }

    ws.flushSink = function () { try { ws.resume(); } catch (e) { } };

    // When data is received from the mesh relay web socket
    ws.on('message', function (data) {
        //console.log(typeof data, data.length);
        if (this.peer != null) {
            //if (typeof data == 'string') { console.log('Relay: ' + data); } else { console.log('Relay:' + data.length + ' byte(s)'); }
            try { this.pause(); this.peer.send(data, ws.flushSink); } catch (e) { }
        }
    });

    // If error, do nothing
    ws.on('error', function (err) { /*console.log('Relay Error: ' + err);*/ });

    // If the mesh relay web socket is closed
    ws.on('close', function (req) {
        if (obj.id != null) {
            var relayinfo = parent.wsrelays[obj.id];
            if (relayinfo != null) {
                if (relayinfo.state == 2) {
                    // Disconnect the peer
                    var peer = (relayinfo.peer1 == obj) ? relayinfo.peer2 : relayinfo.peer1;
                    obj.parent.parent.debug(1, 'Relay disconnect: ' + obj.id + ' (' + obj.remoteaddr + ' --> ' + peer.remoteaddr + ')');
                    peer.id = null;
                    try { peer.ws.close(); } catch (e) { } // Soft disconnect
                    try { peer.ws._socket._parent.end(); } catch (e) { } // Hard disconnect
                } else {
                    obj.parent.parent.debug(1, 'Relay disconnect: ' + obj.id + ' (' + obj.remoteaddr + ')');
                }
                delete parent.wsrelays[obj.id];
            }
            obj.peer = null;
            obj.id = null;
        }
    });
    
    return obj;
}

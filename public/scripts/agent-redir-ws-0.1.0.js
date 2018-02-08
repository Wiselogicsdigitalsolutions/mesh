/** 
* @description Mesh Agent Transport Module - using websocket relay
* @author Ylian Saint-Hilaire
* @version v0.0.1f
*/

// Construct a MeshServer agent direction object
var CreateAgentRedirect = function (meshserver, module, serverPublicNamePort) {
    var obj = {};
    obj.m = module; // This is the inner module (Terminal or Desktop)
    module.parent = obj;
    obj.meshserver = meshserver;
    obj.nodeid = null;
    obj.State = 0;
    obj.socket = null;
    obj.connectstate = -1;
    obj.tunnelid = Math.random().toString(36).substring(2); // Generate a random client tunnel id
    obj.protocol = module.protocol; // 1 = SOL, 2 = KVM, 3 = IDER, 4 = Files, 5 = FileTransfer
    obj.attemptWebRTC = false;
    obj.webRtcActive = false;
    obj.webSwitchOk = false;
    obj.webrtc = null;
    obj.webchannel = null;
    obj.onStateChanged = null;
    obj.debugmode = 0;

    // Private method
    //obj.debug = function (msg) { console.log(msg); }

    obj.Start = function (nodeid) {
        var url2, url = window.location.protocol.replace("http", "ws") + "//" + window.location.host + window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/')) + "/meshrelay.ashx?id=" + obj.tunnelid;
        //if (serverPublicNamePort) { url2 = window.location.protocol.replace("http", "ws") + "//" + serverPublicNamePort + "/meshrelay.ashx?id=" + obj.tunnelid; } else { url2 = url; }
        obj.nodeid = nodeid;
        obj.connectstate = 0;
        obj.socket = new WebSocket(url);
        obj.socket.onopen = obj.xxOnSocketConnected;
        obj.socket.onmessage = obj.xxOnMessage;
        obj.socket.onerror = function (e) { console.error(e); }
        obj.socket.onclose = obj.xxOnSocketClosed;
        obj.xxStateChange(1);
        //obj.meshserver.Send({ action: 'msg', type: 'tunnel', nodeid: obj.nodeid, value: url2 });
        obj.meshserver.Send({ action: 'msg', type: 'tunnel', nodeid: obj.nodeid, value: "*/meshrelay.ashx?id=" + obj.tunnelid });
        //obj.debug("Agent Redir Start: " + url);
    }

    obj.xxOnSocketConnected = function () {
        if (obj.debugmode == 1) { console.log('onSocketConnected'); }
        //obj.debug("Agent Redir Socket Connected");
        obj.xxStateChange(2);
    }

    // Called to pass websocket control messages
    obj.xxOnControlCommand = function (msg) {
        var controlMsg;
        try { controlMsg = JSON.parse(msg); } catch (e) { return; }
        //console.log(controlMsg);
        if (obj.webrtc != null) {
            if (controlMsg.type == 'answer') {
                obj.webrtc.setRemoteDescription(new RTCSessionDescription(controlMsg), function () { /*console.log('WebRTC remote ok');*/ }, obj.xxCloseWebRTC);
            } else if (controlMsg.type == 'webrtc0') {
                obj.webSwitchOk = true; // Other side is ready for switch over
                performWebRtcSwitch();
            } else if (controlMsg.type == 'webrtc1') {
                obj.socket.send("{\"type\":\"webrtc2\"}"); // Confirm we got end of data marker, indicates data will no longer be received on websocket.
            } else if (controlMsg.type == 'webrtc2') {
                // TODO: Resume/Start sending data over WebRTC
            }
        }
    }

    function performWebRtcSwitch() {
        if ((obj.webSwitchOk == true) && (obj.webRtcActive == true)) {
            obj.socket.send("{\"type\":\"webrtc1\"}"); // Indicate to the other side that data traffic will no longer be sent over websocket.
            // TODO: Hold/Stop sending data over websocket
            if (obj.onStateChanged != null) { obj.onStateChanged(obj, obj.State); }
        }
    }

    // Close the WebRTC connection, should be called if a problem occurs during WebRTC setup.
    obj.xxCloseWebRTC = function () {
        try { obj.webchannel.send("{\"type\":\"close\"}"); } catch (e) { }
        if (obj.webchannel != null) { try { obj.webchannel.close(); } catch (e) { } obj.webchannel = null; }
        if (obj.webrtc != null) { try { obj.webrtc.close(); } catch (e) { }  obj.webrtc = null; }
        obj.webRtcActive = false;
    }

    obj.xxOnMessage = function (e) {
        //if (obj.debugmode == 1) { console.log('Recv', e.data); }
        if (obj.State < 3) {
            if (e.data == 'c') {
                obj.socket.send(obj.protocol);
                obj.xxStateChange(3);

                if (obj.attemptWebRTC == true) {
                    // Try to get WebRTC setup
                    var configuration = null; //{ "iceServers": [ { 'urls': 'stun:stun.services.mozilla.com' }, { 'urls': 'stun:stun.l.google.com:19302' } ] };
                    if (typeof RTCPeerConnection !== 'undefined') { obj.webrtc = new RTCPeerConnection(configuration); }
                    else if (typeof webkitRTCPeerConnection !== 'undefined') { obj.webrtc = new webkitRTCPeerConnection(configuration); }
                    if (obj.webrtc != null) {
                        obj.webchannel = obj.webrtc.createDataChannel("DataChannel", {}); // { ordered: false, maxRetransmits: 2 }
                        obj.webchannel.onmessage = function (event) { obj.xxOnMessage({ data: event.data }); };
                        obj.webchannel.onopen = function () { obj.webRtcActive = true; performWebRtcSwitch(); };
                        obj.webchannel.onclose = function (event) { /*console.log('WebRTC close');*/ if (obj.webRtcActive) { obj.Stop(); } }
                        obj.webrtc.onicecandidate = function (e) {
                            if (e.candidate == null) {
                                obj.socket.send(JSON.stringify(obj.webrtcoffer)); // End of candidates, send the offer
                            } else {
                                obj.webrtcoffer.sdp += ("a=" + e.candidate.candidate + "\r\n"); // New candidate, add it to the SDP
                            }
                        }
                        obj.webrtc.oniceconnectionstatechange = function () {
                            if (obj.webrtc != null) {
                                if ((obj.webrtc.iceConnectionState == 'disconnected') || (obj.webrtc.iceConnectionState == 'failed')) { obj.xxCloseWebRTC(); }
                            }
                        }
                        obj.webrtc.createOffer(function (offer) {
                            // Got the offer
                            obj.webrtcoffer = offer;
                            obj.webrtc.setLocalDescription(offer, function () { /*console.log('WebRTC local ok');*/ }, obj.xxCloseWebRTC);
                        }, obj.xxCloseWebRTC, { mandatory: { OfferToReceiveAudio: false, OfferToReceiveVideo: false } });
                    }
                }

                return;
            }
        }

        if (typeof e.data == 'string') {
            // Control messages, most likely WebRTC setup 
            obj.xxOnControlCommand(e.data);
            return;
        }

        if (typeof e.data == 'object') {
            var f = new FileReader();
            if (f.readAsBinaryString) {
                // Chrome & Firefox (Draft)
                f.onload = function (e) { obj.xxOnSocketData(e.target.result); }
                f.readAsBinaryString(new Blob([e.data]));
            } else if (f.readAsArrayBuffer) {
                // Chrome & Firefox (Spec)
                f.onloadend = function (e) { obj.xxOnSocketData(e.target.result); }
                f.readAsArrayBuffer(e.data);
            } else {
                // IE10, readAsBinaryString does not exist, use an alternative.
                var binary = "";
                var bytes = new Uint8Array(e.data);
                var length = bytes.byteLength;
                for (var i = 0; i < length; i++) { binary += String.fromCharCode(bytes[i]); }
                obj.xxOnSocketData(binary);
            }
        } else {
            // If we get a string object, it maybe the WebRTC confirm. Ignore it.
            //obj.debug("Agent Redir Relay - OnData - " + typeof e.data + " - " + e.data.length);
            obj.xxOnSocketData(e.data);
        }
    };
   
    obj.xxOnSocketData = function (data) {
        if (!data || obj.connectstate == -1) return;
        if (typeof data === 'object') {
            // This is an ArrayBuffer, convert it to a string array (used in IE)
            var binary = "", bytes = new Uint8Array(data), length = bytes.byteLength;
            for (var i = 0; i < length; i++) { binary += String.fromCharCode(bytes[i]); }
            data = binary;
        }
        else if (typeof data !== 'string') return;
        //console.log("xxOnSocketData", rstr2hex(data));
        return obj.m.ProcessData(data);
    }
    
    obj.Send = function (x) {
        //obj.debug("Agent Redir Send(" + obj.webRtcActive + ", " + x.length + "): " + rstr2hex(x));
        //console.log("Agent Redir Send(" + obj.webRtcActive + ", " + x.length + "): " + rstr2hex(x));
        if (obj.socket != null && obj.socket.readyState == WebSocket.OPEN) {
            if (typeof x == 'string') {
                if (obj.debugmode == 1) {
                    var b = new Uint8Array(x.length), c = [];
                    for (var i = 0; i < x.length; ++i) { b[i] = x.charCodeAt(i); c.push(x.charCodeAt(i)); }
                    if (obj.webRtcActive == true) { obj.webchannel.send(b.buffer); } else { obj.socket.send(b.buffer); }
                    //console.log('Send', c);
                } else {
                    var b = new Uint8Array(x.length);
                    for (var i = 0; i < x.length; ++i) { b[i] = x.charCodeAt(i); }
                    if (obj.webRtcActive == true) { obj.webchannel.send(b.buffer); } else { obj.socket.send(b.buffer); }
                }
            } else {
                //if (obj.debugmode == 1) { console.log('Send', x); }
                if (obj.webRtcActive == true) { obj.webchannel.send(x); } else { obj.socket.send(x); }
            }
        }
    }

    obj.xxOnSocketClosed = function () {
        //obj.debug("Agent Redir Socket Closed");
        //if (obj.debugmode == 1) { console.log('onSocketClosed'); }
        obj.Stop(1);
    }

    obj.xxStateChange = function(newstate) {
        if (obj.State == newstate) return;
        obj.State = newstate;
        obj.m.xxStateChange(obj.State);
        if (obj.onStateChanged != null) obj.onStateChanged(obj, obj.State);
    }

    obj.Stop = function (x) {
        if (obj.debugmode == 1) { console.log('stop', x); }
        //obj.debug("Agent Redir Socket Stopped");
        obj.connectstate = -1;
        obj.xxCloseWebRTC();
        if (obj.socket != null) {
            try { if (obj.socket.readyState == 1) { obj.socket.send("{\"type\":\"close\"}"); obj.socket.close(); } } catch (e) { }
            obj.socket = null;
        }
        obj.xxStateChange(0);
    }

    return obj;
}

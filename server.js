const config = require('./config');
const uuid = require('node-uuid');
const crypto = require('crypto');
const WebSocket = require('ws');
const zmq = require('zeromq');

function shutdown() {
  console.log("shutting down gracefully...");
  routerSocket.close();
  pubSocket.close();
  setTimeout(function() {
    console.log("shutdown complete.");
    process.exit(0);
  }, 1000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// start the integrated messagebus
const pubSocket = zmq.socket('pub');
pubSocket.bindSync(config.messageBus.subscriptionUri);

const routerSocket = zmq.socket('router');
routerSocket.bind(config.messageBus.messageUri);
routerSocket.on('message', function(address, to, from, timestamp, message) {
  pubSocket.send([to, from, timestamp, message]);
});

const wss = new WebSocket.Server({ port: config.webSocket.port });
wss.on('connection', function connection(ws) {
  const requestCallbacks = {};
  const keepAliveTimer = setInterval(function() {
    try {
      ws.send('{}');
    } catch (error) {}
  }, config.webSocket.keepAliveIntervalMs);

  // make up a unique address on the messagebus
  const address = 'T-' + crypto.createHash('sha256').update("" + uuid.v4()).digest("hex");;
  const session = crypto.createHash('sha256').update("" + uuid.v4()).digest("hex");;
  const subAddress = address+ '_' + session;
  var sipContextId = null;

  // create a zeromq SUB socket and subscribe to the unique address
  const sub = zmq.socket('sub');
  sub.connect(config.messageBus.subscriptionUri);
  sub.subscribe(address);

  sub.on('message', function(to, from, timestamp, message) {
    to = to.toString();
    from = from.toString();
    timestamp = timestamp.toString();
    message = message.toString();
    try {
      var json = JSON.parse(message);
      if (json.webrtc) {
        ws.send(JSON.stringify(
          {
    	    messageEvent: {
    		to: to,
    		from: from,
    		timestamp: timestamp,
    		message: json
    	    }
          }
        ));
      } else if (json.sip && json.sip.createContextResponse) {
	const callback = requestCallbacks[json.sip.createContextResponse.uuid];
	if (callback) {
	  delete requestCallbacks[json.sip.createContextResponse.uuid];
	  callback(json.sip.createContextResponse);
	}
      }
    } catch (error) {
      console.log(error);
    }
  });

  ws.on('message', function(message) {
    try {
      var msg = JSON.parse(message);
      if (msg) {
        if (msg.identityRequest && msg.identityRequest.uuid) {
          // allocate a SIP context before responding with identityResponse
          const requestUuid = uuid.v4();
          requestCallbacks[requestUuid] = function(response) {
            if (!response || !response.success || !response.context || !response.context.id) {
              ws.send(JSON.stringify(
                {
                  identityResponse: {
                    success: false,
                    uuid: msg.identityRequest.uuid
                  }
                }
              ));
            } else {
              sipContextId = response.context.id;
              ws.send(JSON.stringify(
                {
                  identityResponse: {
                    success: true,
                    address: address,
                    session: session,
                    uuid: msg.identityRequest.uuid
                  }
                }
              ));
            }
          };
          pubSocket.send(['ZMQ2SIP', subAddress, Date.now(), JSON.stringify(
            {
              sip: {
                createContextRequest: {
                  uuid: requestUuid
                }
              }
            }
          )]);
        } else if (msg.messageRequest && msg.messageRequest.message) {
          // add the SIP context ID to the message if applicable
          if (msg.messageRequest.message.sip) {
            msg.messageRequest.message.sip.context = sipContextId;
          } else if (msg.messageRequest.message.webrtc) {
            if (msg.messageRequest.message.webrtc.sessionOffer) {
              if (!msg.messageRequest.message.webrtc.sessionOffer.sip) {
                msg.messageRequest.message.webrtc.sessionOffer.sip = {};
              }
              msg.messageRequest.message.webrtc.sessionOffer.sip.context = { id: sipContextId };
            } else if (msg.messageRequest.message.webrtc.sessionAnswer) {
              if (!msg.messageRequest.message.webrtc.sessionAnswer.sip) {
                msg.messageRequest.message.webrtc.sessionAnswer.sip = {};
              }
              msg.messageRequest.message.webrtc.sessionAnswer.sip.context = { id: sipContextId };
            } else if (msg.messageRequest.message.webrtc.sessionAcknowledge) {
              if (!msg.messageRequest.message.webrtc.sessionAcknowledge.sip) {
                msg.messageRequest.message.webrtc.sessionAcknowledge.sip = {};
              }
              msg.messageRequest.message.webrtc.sessionAcknowledge.sip.context = { id: sipContextId };
            }
          }
	  // directly publish the message on the PUB socket
	  if (!msg.messageRequest.to) {
	    msg.messageRequest.to = 'ZMQ2SIP';
	  }
          pubSocket.send([msg.messageRequest.to, subAddress, Date.now(), JSON.stringify(msg.messageRequest.message)]);
        }
      }
    } catch (error) {
      console.log(error);
    }
  });

  ws.on('close', function() {
    clearInterval(keepAliveTimer);
    if (sipContextId) {
      // free all allocated SIP resources (hangup active calls, unregister registrations)
      pubSocket.send(['ZMQ2SIP', subAddress, Date.now(), JSON.stringify(
        {
          sip: {
            destroyContextRequest: {
              id: sipContextId,
              uuid: uuid.v4()
            }
          }
        }
      )]);
      sipContextId = null;
    }
    sub.close();
  });
});

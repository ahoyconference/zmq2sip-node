module.exports = {
  messageBus: {
    messageUri: "tcp://127.0.0.1:60508",
    subscriptionUri: "tcp://127.0.0.1:60507"
  },
  webSocket: {
    port: 8888,
    keepAliveIntervalMs: 10000
  }
}

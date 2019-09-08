import {
  WebSocketConnectEvent,
  WebSocketDisconnectEvent,
  WebSocketEvent,
} from './lambda-events/index.js'
import debugLog from '../debugLog.js'
import LambdaFunctionPool from '../lambda/index.js'
import serverlessLog from '../serverlessLog.js'
import { WEBSOCKETS_API_ROUTE_SELECTION_EXPRESSION_DEFAULT } from '../config/index.js'
import { createUniqueId, jsonPath } from '../utils/index.js'

const { parse, stringify } = JSON

export default class WebSocketClients {
  constructor(options, config, provider) {
    this._clients = new Map()
    this._config = config
    this._lambdaFunctionPool = new LambdaFunctionPool()
    this._options = options
    this._provider = provider
    this._webSocketRoutes = new Map()
    this._websocketsApiRouteSelectionExpression =
      provider.websocketsApiRouteSelectionExpression ||
      WEBSOCKETS_API_ROUTE_SELECTION_EXPRESSION_DEFAULT
  }

  _addWebSocketClient(client, connectionId) {
    this._clients.set(client, connectionId)
    this._clients.set(connectionId, client)
  }

  _removeWebSocketClient(client) {
    const connectionId = this._clients.get(client)

    this._clients.delete(client)
    this._clients.delete(connectionId)

    return connectionId
  }

  _getWebSocketClient(connectionId) {
    return this._clients.get(connectionId)
  }

  async _processEvent(websocketClient, connectionId, route, event) {
    let routeOptions = this._webSocketRoutes.get(route)

    if (!routeOptions && route !== '$connect' && route !== '$disconnect') {
      routeOptions = this._webSocketRoutes.get('$default')
    }

    if (!routeOptions) {
      return
    }

    const sendError = (err) => {
      if (websocketClient.readyState === /* OPEN */ 1) {
        websocketClient.send(
          stringify({
            connectionId,
            message: 'Internal server error',
            requestId: '1234567890',
          }),
        )
      }

      // mimic AWS behaviour (close connection) when the $connect route handler throws
      if (route === '$connect') {
        websocketClient.close()
      }

      debugLog(`Error in route handler '${routeOptions}'`, err)
    }

    const { functionName, functionObj } = routeOptions

    const lambdaFunction = this._lambdaFunctionPool.get(
      functionName,
      functionObj,
      this._provider,
      this._config,
      this._options,
    )

    const requestId = createUniqueId()

    lambdaFunction.setEvent(event)
    lambdaFunction.setRequestId(requestId)

    // let result

    try {
      /* result = */ await lambdaFunction.runHandler()

      const {
        billedExecutionTimeInMillis,
        executionTimeInMillis,
      } = lambdaFunction

      serverlessLog(
        `(λ: ${functionName}) RequestId: ${requestId}  Duration: ${executionTimeInMillis.toFixed(
          2,
        )} ms  Billed Duration: ${billedExecutionTimeInMillis} ms`,
      )

      // TODO what to do with "result"?
    } catch (err) {
      console.log(err)
      sendError(err)
    }
  }

  _getRouteSelectionExpression(value) {
    if (this._websocketsApiRouteSelectionExpression == null) {
      return undefined
    }

    let json

    try {
      json = parse(value)
    } catch (err) {
      // no-op
    }

    return jsonPath(json, this._websocketsApiRouteSelectionExpression)
  }

  addClient(webSocketClient, request, connectionId) {
    this._addWebSocketClient(webSocketClient, connectionId)

    const connectEvent = new WebSocketConnectEvent(
      connectionId,
      request,
      this._options,
    ).create()

    this._processEvent(webSocketClient, connectionId, '$connect', connectEvent)

    webSocketClient.on('close', () => {
      debugLog(`disconnect:${connectionId}`)

      this._removeWebSocketClient(webSocketClient)

      const disconnectEvent = new WebSocketDisconnectEvent(
        connectionId,
      ).create()

      this._processEvent(
        webSocketClient,
        connectionId,
        '$disconnect',
        disconnectEvent,
      )
    })

    webSocketClient.on('message', (message) => {
      debugLog(`message:${message}`)

      let route = this._getRouteSelectionExpression()

      if (typeof route !== 'string') {
        route = undefined
      }

      route = route || '$default'

      debugLog(`route:${route} on connection=${connectionId}`)

      const event = new WebSocketEvent(connectionId, route, message).create()

      this._processEvent(webSocketClient, connectionId, route, event)
    })
  }

  addRoute(functionName, functionObj, route) {
    // set the route name
    this._webSocketRoutes.set(route, {
      functionName,
      functionObj,
    })

    serverlessLog(`route '${route}'`)
  }

  close(connectionId) {
    const client = this._getWebSocketClient(connectionId)

    if (client) {
      client.close()
      return true
    }

    return false
  }

  send(connectionId, payload) {
    const client = this._getWebSocketClient(connectionId)

    if (client) {
      client.send(payload)
      return true
    }

    return false
  }
}
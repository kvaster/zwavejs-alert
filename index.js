// Simple zwavejs2mqtt plugin for alerting

https = require('https')

function isDefined(a) {
    return a !== undefined && a !== null
}

function getOrDefault(dict, id, func) {
    let v = dict[id]
    if (!isDefined(v)) {
        v = func()
        dict[id] = v
    }

    return v
}

class ZwavejsAlert {
    constructor(ctx, cfg) {
        this.zwave = ctx.zwave
        this.mqtt = ctx.mqtt
        this.logger = ctx.logger
        this.app = ctx.app

        this.apiKey = cfg.apiKey
        this.chatId = cfg.chatId

        this.logger.info('Starting ZwaveJS alert plugin')

        this.nodes = {}

        this.zwave.on('valueChanged', this.onValueChanged.bind(this))
        this.zwave.on('nodeRemoved', this.onNodeRemoved.bind(this))
        this.zwave.on('nodeStatus', this.onNodeStatus.bind(this))

        this.sendMsg('*ZWave:* alert system started')
    }

    async destroy() {
        this.logger.info('Stopping ZwaveJS alert plugin')

        this.sendMsg('*ZWave:* alert system stopped')
    }

    onNodeRemoved(node) {
        delete this.nodes[node.id]
    }

    onNodeStatus(node) {
        const n = this.getNode(node.id)
        const newStatus = node.status.toString()

        this.logger.info(`Node status: ${n.status} -> ${newStatus}`)

        if (n.status !== newStatus) {
            if (newStatus === 'Dead' || n.status === 'Dead') {
                this.sendMsg(`*ZWave:* ${node.name} - ${node.loc}\nStatus: ${n.status} -> *${newStatus}*`)
            }
        }

        n.status = newStatus
    }

    getNode(id) {
        return getOrDefault(this.nodes, id, () => ({
            status: 'Unknown',
            values: {}
        }))
    }

    onValueChanged(value) {
        this.logger.info(`value updated: ${JSON.stringify(value)}`)

        const n = this.getNode(value.nodeId)
        const zn = this.zwave.nodes.get(value.nodeId)

        switch (value.commandClass) {
            case 0x80: // Battery
                switch (value.property.toString()) {
                    case 'isLow': {
                        const v = getOrDefault(n.values, value.id, () => ({isLow: false}))
                        if (value.value !== v.isLow) {
                            this.sendValueMsg(value, zn, isLow ? '*Battery IS LOW!*' : '*Battery is not low*')
                        }
                        break
                    }
                    case 'level': {
                        const v = getOrDefault(n.values, value.id, () => ({}))
                        if (value.value <= 30 || (isDefined(v.level) && v.level !== value.value)) {
                            this.sendValueMsg(value, zn, `*Battery level is:* ${value.value}%`)
                        }
                        v.level = value.value
                        break
                    }
                }
                break

            case 0x71: // Notification
                if (value.readable && value.list) {
                    let states = {}
                    for (const s of value.states) {
                        states[s.value] = s.text
                    }

                    let state = value.value
                    if (isDefined(state)) {
                        state = states[state]
                    }

                    if (!isDefined(state)) {
                        state = 'idle'
                    }

                    const v = getOrDefault(n.values, value.id, () => ({}))

                    if (isDefined(v.state) || state !== 'idle') {
                        this.sendValueMsg(value, zn, `*Alert:* ${state}`)
                    }

                    v.state = state
                }
                break
        }
    }

    sendValueMsg(v, n, msg) {
        let m = `*ZWave:* ${n.name} - ${n.loc}\nClass: ${v.commandClassName}\nEndpoint: ${v.endpoint}\nProperty: ${v.propertyName}`
        if (isDefined(v.propertyKeyName)) {
            m = `${m}\nPropertyKey: ${v.propertyKeyName}`
        }
        m = `${m}\n\n${msg}`

        this.sendMsg(m)
    }

    sendMsg(msg) {
        const params = {
            parse_mode: 'Markdown',
            chat_id: this.chatId,
            text: msg
        }

        const query = Object.entries(params).map((e) => `${e[0]}=${encodeURIComponent(e[1])}`).join('&')

        const uri = `https://api.telegram.org/bot${this.apiKey}/sendMessage?${query}`

        const req = https.get(uri, (res) => {
            if (res.statusCode !== 200) {
                this.logger.warn(`error sending alert: ${res.statusCode}`)
            }
        })

        req.on('error', (err) => {
            this.logger.warn(`error sending alert: ${err.message}`)
        })

        req.end()
    }
}

module.exports = function (ctx) {
    return new ZwavejsAlert(ctx, require('./config.js'))
}

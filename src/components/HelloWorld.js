import axios from 'axios'
import AsyncLock from 'async-lock'
import { networks, TransactionBuilder } from 'bitcoinjs-lib'
import coinSelect from 'coinselect'
import TransportU2F from '@ledgerhq/hw-transport-u2f'
import AppBTC from '@ledgerhq/hw-app-btc'
import BigNumber from 'bignumber.js'

const defaultReceiver = 'mt7r5FKWoKXPtAdkuCYm3AyoQk4vyxUdYA'
const DEFAULT_FEE_RATE = 55

export const API = axios.create({
  baseURL: 'https://test-insight.bitpay.com/api/'
})

const LOCK = 'LedgerDevice'

class LedgerDevice {
  constructor () {
    this.lock = new AsyncLock()
  }

  async getAddressInfo () {
    return this._safeExec(
      async () => {
        const transport = await TransportU2F.create()
        const app = new AppBTC(transport)
        return await app.getWalletPublicKey("44'/1'/0'/0")
      }
    )
  }

  async serializeTransactionOutputs (...args) {
    return this._safeExec(
      async () => {
        const transport = await TransportU2F.create()
        const app = new AppBTC(transport)
        return app.serializeTransactionOutputs(...args)
      }
    )
  }

  async splitTransaction (...args) {
    return this._safeExec(
      async () => {
        const transport = await TransportU2F.create()
        const app = new AppBTC(transport)
        return app.splitTransaction(...args)
      }
    )
  }

  async createPaymentTransactionNew (...args) {
    return this._safeExec(
      async () => {
        const transport = await TransportU2F.create()
        transport.setDebugMode(true)
        const app = new AppBTC(transport)
        return app.createPaymentTransactionNew(...args)
      }
    )
  }

  async _safeExec (callable) {
    return this.lock.acquire(
      LOCK,
      callable
    )
  }
}

const device = new LedgerDevice()

export default {
  data () {
    return {
      path: "44'/1'/0'/0/0",
      fromAddress: null,
      fromPublicKey: null,
      toAddress: null,
      fee: null,
      value: null,
      rawHex: null,
      signedHex: null,
      history: [],
      utxos: null,
      prepareError: null,
      signError: null
    }
  },
  methods: {
    async handleBroadcastTx () {
      const params = new URLSearchParams()
      params.append('rawtx', this.signedHex)
      const { data } = await API.post('tx/send', params)
      this.history.push(data.txid)
      this.signedHex = null
      this.rawHex = null
      this.value = null
      this.utxos = null
      this.fee = null
      this.toAddress = null
      this.fromAddress = null
      this.utxos = []
    },
    handleDefaultTo () {
      this.toAddress = defaultReceiver
      this.handleToUpdate()
    },
    handleReset () {
      this.history = []
      this.fromAddress = null
    },
    async handleConnect () {
      const info = await device.getAddressInfo()
      const { bitcoinAddress, publicKey } = info
      const { data } = await API.get(`addr/${bitcoinAddress}/utxo`)
      this.utxos = data
      this.fromAddress = bitcoinAddress
      this.fromPublicKey = publicKey
    },
    handleToUpdate () {
      this.history = []
      this.value = null
      this.fee = null
      this.rawHex = null
      this.signedHex = null
      this.prepareError = null
      this.signError = null
      // this.fromAddress = ''
    },
    async handleValueUpdate () {
      try {

        const utxos = this.utxos.map(entry => ({
          txId: entry.txid,
          vout: entry.vout,
          value: entry.satoshis
        }))

        const destinations = [
          {
            address: this.toAddress,
            value: new BigNumber(this.value).multipliedBy(100000000).integerValue().toNumber()
          }
        ]

        const { inputs, outputs, fee } = coinSelect(
          utxos,
          destinations,
          DEFAULT_FEE_RATE
        )

        if (!outputs) {
          throw Error('Cannot build tx')
        }

        const txb = new TransactionBuilder(networks.testnet)
        // const spk = script.pubKey.output.encode(Buffer.from(this.fromPublicKey, 'hex'))
        // console.log('spk', spk)
        // const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: regtest })
        inputs.forEach(input => txb.addInput(input.txId, input.vout))
        outputs.forEach(output => {
          if (!output.address) {
            output.address = this.fromAddress
          }
          txb.addOutput(output.address, output.value)
        })

        this.fee = fee
        this.rawHex = txb.buildIncomplete().toHex()
        this.signedHex = null
        this.prepareError = null
      } catch (e) {
        // eslint-disable-next-line
        console.log(e)
        this.fee = null
        this.rawHex = null
        this.signedHex = null
        this.prepareError = e.message
      }
    },
    async handleSignTx () {
      try {

        const txs = await Promise.all(
          this.utxos.map(async utxo => {
            const { data } = await API.get(`rawtx/${utxo.txid}`)
            return [await device.splitTransaction(data.rawtx), utxo.vout]
          })
        )

        const bufferedInput = await device.splitTransaction(this.rawHex)
        const outputScript = await device.serializeTransactionOutputs(bufferedInput)
        const outputScriptHex = await outputScript.toString("hex")

        const result = await device
          .createPaymentTransactionNew(
            txs,
            ["44'/1'/0'/0"],
            "44'/1'/0'/0",
            outputScriptHex
          )

        this.signedHex = result
      } catch (e) {
        // eslint-disable-next-line
        console.log(e)
      }
    }
  }
}

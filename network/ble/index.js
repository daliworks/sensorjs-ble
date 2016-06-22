'use strict';

var util = require('util'),
  noble = require('noble'),
  async = require('async'),
  _ = require('lodash');

//internal lib
var sensorDriver = require('../../index'),
    Network = sensorDriver.Network,  
    Device = sensorDriver.Device;

var DEVICE_SCAN_TIMEOUT = 10000,
    DEVICE_CONN_TIMEOUT = 10000,
    SERVICE_DISCOVERY_TIMEOUT = 15000;

var logger = Network.getLogger();

function Ble(options) {
  Network.call(this, 'ble'/*networkName*/, options);
}

util.inherits(Ble, Network);

Ble.prototype.getDevice = function (addr, options, cb) {
  var self = this;

  if (typeof options === 'function') {
    cb = options;
  }

  if (this.device && this.device.deviceHandle &&
      noble._peripherals[addr] && noble._peripherals[addr].state === 'connected') {
    logger.debug('[BLE/Network] Device is already connected');
    return cb && cb(null, this.device);
  }

  // TODO: connect directly without scanning if the sensor device(peripheral) is registered

  if (this.underDiscover) {
    logger.warn('[BLE/Network] Under discovering');
    return cb && cb(new Error('under discovering'));
  }

  this._discover(addr, options.model, options.serviceUUID, options, function (err, device) {
    self.underDiscover = false;
    return cb && cb(err, device);
  });
};

Ble.prototype.discover = function (driverName/*or model*/, options, cb) {
  var self = this,
      peripherals = [],
      models;

  if (typeof options === 'function') {
    cb = options;
    options = undefined;
  }

  if (this.underDiscover) {
    if (cb) {
      cb(new Error('already scanning'));
    } else {
      this.emit('discover', 'error', new Error('already scanning'));
    }
    return;
  }

  this.underDiscover = true;

  var onDiscover = function(peripheral) {
    logger.debug('[BLE/Network] On discover', peripheral.uuid, peripheral.advertisement);
    peripherals.push(peripheral);
  };

  var startScan = function () {
    if (self.scanTimer) {
      logger.error('[BLE/Network] already startScan');
      return; //already scan
    }

    noble.on('discover', onDiscover);

    noble.startScanning();

    self.scanTimer = setTimeout(function () {
      self.scanTimer = null;
      noble.removeListener('discover', onDiscover);
      noble.stopScanning();
    }, DEVICE_SCAN_TIMEOUT);
  };

  noble.once('scanStart', function () {
    logger.debug('[BLE/Network] On scanStart');
  });

  noble.once('scanStop', function () {
    var founds = [];

    if (self.scanTimer) {
      clearTimeout(self.scanTimer);
      self.scanTimer = null;
    }

    logger.debug('[BLE/Network] On scanStop');

    if (cb) {
      self.emit('discover', 'scanStop');
    }

    _.forEach(peripherals, function (peripheral) {
      _.forEach(models, function (model) {
        var props = sensorDriver.getSensorProperties(model);

        if (peripheral.advertisement && peripheral.advertisement.localName && props && props.bleLocalName &&
            peripheral.advertisement.localName.toUpperCase() === props.bleLocalName.toUpperCase()) {
          var device = new Device(self, peripheral.uuid, null,
              [{ id: model + '-' + peripheral.uuid, model: model }]);

          founds.push(device);

          self.emit('discovered', device);
        }
      });
    });

    logger.debug('[BLE/Network] founds', founds);

    self.underDiscover = false;

    return cb && cb(null, founds);
  });

  // 1. Get models from driverName or from model
  models = sensorDriver.getDriverConfig()[driverName];
  if (!models) { //find model
    if(_.findKey(sensorDriver.getDriverConfig(), function (models) {
      return _.contains(models, driverName);
    })) {
      models = [driverName];
    } else {
      return cb && cb(new Error('model not found'));
    }
  }

  // 2. Start BLE Scanning
  logger.debug('noble.state', noble.state);
  if (noble.state === 'poweredOn' || noble.state === 'unsupported') {
    startScan();
  } else {
    noble.once('stateChange', function() {
      startScan();
    });
  }
};

Ble.prototype._discover = function (addr, model, serviceUUID, options, cb) {
  var self = this;

  if (this.underDiscover) {
    if (cb) {
      cb(new Error('already discovering'));
    } else {
      this.emit('discover', 'error', new Error('already discovering'));
    }
    return;
  }

  this.underDiscover = true;
  this.peripheral = null;

  var onDiscover = function(peripheral) {
    logger.debug('on discover', peripheral.uuid, peripheral.advertisement);

    if (addr === peripheral.uuid) {
      self.peripheral = peripheral;
      logger.debug('on discover - discovered', peripheral.uuid);
    }
  };

  var startScan = function () {
    if (self.scanTimer) {
      logger.error('[BLE/Network] already startScan');
      return; //already scan
    }

    noble.on('discover', onDiscover);
    noble.startScanning();

    self.scanTimer = setTimeout(function () {
      self.scanTimer = null;
      noble.removeListener('discover', onDiscover);
      noble.stopScanning();
    }, DEVICE_SCAN_TIMEOUT);
  };

  noble.once('scanStart', function () {
    logger.debug('on scanStart');
  });

  noble.once('scanStop', function () {
    var peripheral, connTimer;

    if (self.scanTimer) {
      clearTimeout(self.scanTimer);
      self.scanTimer = null;
    }

    logger.debug('[BLE/Network] On scanStop');

    if (cb) {
      self.emit('discover', 'scanStop');
    }

    if (self.peripheral) {
      peripheral = self.peripheral;

      connTimer = setTimeout(function () {
        try { peripheral.disconnect(); } catch (e) {}

        connTimer = null;

        logger.warn('[BLE/Network] Timeout on connecting with peripheral',
            DEVICE_CONN_TIMEOUT, peripheral.uuid);

        return cb && cb(new Error('Timeout on connecting with peripheral'));
      }, DEVICE_CONN_TIMEOUT);

      peripheral.once('error', function () {
        if (connTimer) {
          try { peripheral.disconnect(); } catch (e) {}
          clearTimeout(connTimer);
          connTimer = null;
        }
        logger.error('[BLE/Network] On error with peripheral', peripheral.uuid);
      });

      peripheral.connect(function (error) {
        var svcTimer;

        if (error) {
          logger.error('[BLE/Network] Error on connecting to the peripheral', peripheral.uuid, error);
          return cb && cb(new Error('Error on connecting to the peripheral'));
        }

        if (connTimer) {
          clearTimeout(connTimer);
          connTimer = null;
          logger.debug('[BLE/Network] Clearing timeout of connTimer');
        } else {
          logger.warn('[BLE/Network] Return - already timeout on connecting with peripheral', peripheral.uuid);
          return; //do nothing already timeout
        }

        logger.debug('[BLE/Network] Connected and Discovering service', peripheral.uuid, peripheral.advertisement);

        svcTimer = setTimeout(function () {
          try { peripheral.disconnect(); } catch (e) {}

          svcTimer = null;

          logger.info('[BLE/Network] Timeout on discovering services of peripheral',
              SERVICE_DISCOVERY_TIMEOUT, peripheral.uuid);

          return cb && cb(new Error('Timeout on discovering services of peripheral'));
        }, SERVICE_DISCOVERY_TIMEOUT);

        peripheral.discoverSomeServicesAndCharacteristics([serviceUUID], null, function (error, services) {
          var device, props;

          if (error) {
            logger.error('[BLE/Network] Error with discoverSomeServicesAndCharacteristics', error);
            return cb && cb(error);
          }

          if (svcTimer) {
            clearTimeout(svcTimer);
            svcTimer = null;
            logger.debug('[BLE/Network] Clearing timeout of svcTimer');
          } else {
            logger.warn('[BLE/Network] Return - already timeout on discovering services', peripheral.uuid);
            return; //do nothing already timeout
          }

          logger.debug('[BLE/Network] Services are discovered', services);

          props = sensorDriver.getSensorProperties(model);

          _.forEach(services, function (service) {
            if (service.uuid === props.ble.service) {
              device = new Device(self, peripheral.uuid, null
                          [{id:model + '-' + peripheral.uuid,
                            model: model,
                            deviceHandle: peripheral}]);

              peripheral.once('disconnect', function() {
                logger.debug('[BLE/Network] Peripheral disconnect / address=', device.address);
                self.emit('disconnect', device);
              });

              logger.debug('[BLE/Network] BLE with service uuid is found and device is created', device);
              self.emit('discovered', device);

              self.device = device;

              return false;
            }
          });

          return cb && cb(null, self.device);
        });
      });
    } else {
      logger.warn('[BLE/Network] On discovering, peripheral is not discovered');
      self.emit('discovered', 'no device');

      return cb && cb(new Error('ble device is not discovered'));
    }
  });

  logger.debug('noble.state', noble.state);

  if (noble.state === 'poweredOn' || noble.state === 'unsupported') {
    startScan();
  } else {
    noble.once('stateChange', function() {
      startScan();
    });
  }
};

module.exports = new Ble();

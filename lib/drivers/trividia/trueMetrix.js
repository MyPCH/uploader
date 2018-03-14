/*
 * == BSD2 LICENSE ==
 * Copyright (c) 2018, Tidepool Project
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the associated License, which is identical to the BSD 2-Clause
 * License as published by the Open Source Initiative at opensource.org.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the License for more details.
 *
 * You should have received a copy of the License along with this program; if
 * not, you can obtain one from Tidepool Project at tidepool.org.
 * == BSD2 LICENSE ==
 */

import _ from 'lodash';
import async from 'async';

// import annotate from '../../eventAnnotations';
import common from '../../commonFunctions';
import TZOUtil from '../../TimezoneOffsetUtil';
import structJs from '../../struct';

const struct = structJs();
const isBrowser = typeof window !== 'undefined';
const debug = isBrowser ? require('bows')('TrueMetrixDriver') : debug;

const HEADER = 0xA0;

const COMMANDS = {
  WAKEUP: '(^)AF',
  IDENTIFY: '(I)9A',
};

class TrueMetrix {
  constructor(cfg) {
    this.cfg = cfg;
    this.hidDevice = this.cfg.deviceComms;
  }

  static extractPacketIntoMessage(bytes) {
    const str = String.fromCharCode.apply(null, bytes);
    const results = str.match(/\n\(([^)]*)\)(\w{2})/);
    console.log('Parsed:', results);

    if (results != null) {
      if (TrueMetrix.verifyChecksum(results[1], results[2])) {
        return results[1];
      }
    }
    return null;
  }

  static buildPacket(command, cmdlength) {
    const datalen = cmdlength + 2; /* we use 2 bytes because we add 1 byte for
                                    the header and 1 byte for the length of
                                    the payload */
    const buf = new ArrayBuffer(datalen);
    const bytes = new Uint8Array(buf);
    if (cmdlength) {
      let ctr = 0;
      ctr += struct.pack(bytes, ctr, 'bb6z', HEADER, cmdlength, command);
      debug('Sending', ctr, 'bytes');
    }
    return buf;
  }

  static verifyChecksum(frame, expected) {
    let checksum = 0;
    for (let i = 0; i < frame.length; ++i) {
      checksum += frame.charCodeAt(i);
    }
    checksum += 0x29 + 0x28; // add frame start and end characters back in

    let checkStr = _.toUpper(checksum.toString(16)).slice(-2);
    checkStr = checkStr.slice(-2);
    return checkStr === _.toUpper(expected);
  }

  static decodeMessage(message) {
    return message;
  }

  static getAnnotations(annotation, data) {
    const annInfo = [];

    if (data.unreportedThreshold) {
      annInfo.push({
        code: 'bayer/smbg/unreported-hi-lo-threshold',
      });
    }
    if (annotation.indexOf('>') !== -1) {
      annInfo.push({
        code: 'bg/out-of-range',
        threshold: data.hiThreshold,
        value: 'high',
      });

      return annInfo;
    } else if (annotation.indexOf('<') !== -1) {
      annInfo.push({
        code: 'bg/out-of-range',
        threshold: data.lowThreshold,
        value: 'low',
      });

      return annInfo;
    }
    return null;
  }

  getOneRecord(cmd, data, callback) {
    const robj = {};
    let error = false;

    async.doWhilst(
      (whilstCb) => {
        this.commandResponse(TrueMetrix.buildPacket(cmd, cmd.length), (err, record) => {
          if (err) {
            return whilstCb(err, null);
          }
          console.log('Record:', record);

          robj.valid = true; // TODO: return message instead
          return whilstCb(null);
        });
      },
      () => (Object.getOwnPropertyNames(robj).length === 0) && !error,
      (err) => {
        if (err) {
          error = true;
          debug('Failure trying to talk to device.');
          debug(err);
          return callback(err, null);
        }
        return callback(null, robj);
      },
    );
  }

  commandResponse(commandpacket, callback) {
    this.hidDevice.send(commandpacket, () => {
      this.getASTMMessage(5000, 3, (err, result) => {
        if (err) {
          return callback(err, null);
        }
        const message = TrueMetrix.decodeMessage(result);
        return callback(null, message);
      });
    });
  }

  getASTMMessage(timeout, retries, cb) {
    let timedOut = false;

    const abortTimer = setTimeout(() => {
      debug('TIMEOUT');
      const e = new Error('Timeout error.');
      e.name = 'TIMEOUT';
      timedOut = true;
      return cb(e, null);
    }, timeout);

    let message;

    async.doWhilst(
      (callback) => {
        this.hidDevice.receive((raw) => {
          try {
            const packet = new Uint8Array(raw);
            console.log('Packet:', common.bytes2hex(packet));
            message = TrueMetrix.extractPacketIntoMessage(packet);

            // Only process if we get data
            if (packet.length === 0) {
              return callback(null, false);
            }

            clearTimeout(abortTimer);
            return callback(null, true);
          } catch (err) {
            debug('Error:', err);
            if (!timedOut) {
              return cb(err);
            }
          }
          return callback(null, false);
        });
      },
      valid => (valid !== true && !timedOut),
      err => cb(err, message),
    );
  }

  static processReadings(readings) {
    _.each(readings, (reading, index) => {
      console.log(readings[index]);
    });
  }
  /*
  prepBGData(progress, data) {
    //build missing data.id
    data.id = data.model + '-' + data.serialNumber;
    this.cfg.builder.setDefaults({ deviceId: data.id});
    var dataToPost = [];
    if (data.bgmReadings.length > 0) {
      for (var i = 0; i < data.bgmReadings.length; ++i) {
        var datum = data.bgmReadings[i];
        if(datum.control === true) {
          debug('Discarding control');
          continue;
        }
        var smbg = this.cfg.builder.makeSMBG()
          .with_value(datum.glucose)
          .with_deviceTime(datum.displayTime)
          .with_timezoneOffset(datum.timezoneOffset)
          .with_conversionOffset(datum.conversionOffset)
          .with_time(datum.displayUtc)
          .with_units(datum.units)
          .set('index', datum.nrec)
          .done();
          if (datum.annotations) {
            _.each(datum.annotations, function(ann) {
              annotate.annotateEvent(smbg, ann);
            });
          }
        dataToPost.push(smbg);
      }
    } else {
      debug('Device has no records to upload');
      throw(new Error('Device has no records to upload'));
    }

    return dataToPost;
  };
  */
}


module.exports = (config) => {
  const cfg = _.clone(config);
  const driver = new TrueMetrix(cfg);

  // With no date & time settings changes available,
  // timezone is applied across-the-board
  cfg.tzoUtil = new TZOUtil(cfg.timezone, new Date().toISOString(), []);

  return {
    /* eslint no-param-reassign:
       [ "error", { "props": true, "ignorePropertyModificationsFor": ["data"] } ] */

    detect(deviceInfo, cb) {
      debug('no detect function needed', deviceInfo);
      cb(null, deviceInfo);
    },

    setup(deviceInfo, progress, cb) {
      debug('in setup!');
      progress(100);
      cb(null, { deviceInfo });
    },

    connect(progress, data, cb) {
      debug('in connect!');

      cfg.deviceComms.connect(data.deviceInfo, cb, (err) => {
        if (err) {
          return cb(err);
        }
        data.disconnect = false;
        progress(100);
        return cb(null, data);
      });
    },

    getConfigInfo(progress, data, cb) {
      debug('in getConfigInfo', data);

      driver.getOneRecord(COMMANDS.WAKEUP, data, (err) => {
        driver.getOneRecord(COMMANDS.IDENTIFY, data, (err2, result) => {
          if (err) {
            return cb(err, null);
          }

          progress(100);
          data.connect = true;
          _.assign(data, result);
          return cb(null, data);
        });
      });
    },

    fetchData(progress, data, cb) {
      debug('in fetchData', data);
      /*
      var recordType = null;
      var dataRecords = [];
      var error = false;

      async.whilst(
        // Get records from the meter until we get the Message Terminator Record (L)
        // The spec says that unless we get this, any preceding data should not be used.
        function () { return (recordType !== ASCII_CONTROL.EOT && recordType !== 'L' && !error); },
        function (callback) {
          getOneRecord(data, function (err, result) {
            if (err) {
              error = true;
            } else {
              recordType = result.recordType;
              // We only collect data records (R)
              if (recordType === 'R' && result.timestamp) {
                progress(100.0 * result.nrec / data.nrecs);
                dataRecords.push(result);
              }
            }
            return callback(err);
          });
        },
        function (err) {
          progress(100);
          if(err || error) {
            data.bgmReadings = [];
          } else {
            debug('fetchData', dataRecords);
            data.bgmReadings = dataRecords;
          }
          data.fetchData = true;
          cb(err, data);
        }
      );
      */
      cb(null, data);
    },

    processData(progress, data, cb) {
      /*
      //debug('in processData');
      progress(0);
      data.bg_data = processReadings(data.bgmReadings);
      try {
        data.post_records = prepBGData(progress, data);
        var ids = {};
        for (var i = 0; i < data.post_records.length; ++i) {
          delete data.post_records[i].index; // Remove index as Jaeb study uses logIndices instead
          var id = data.post_records[i].time + '|' + data.post_records[i].deviceId;
          if (ids[id]) {
            debug('duplicate! %s @ %d == %d', id, i, ids[id] - 1);
            debug(data.post_records[ids[id] - 1]);
            debug(data.post_records[i]);
          } else {
            ids[id] = i + 1;
          }
        }
        progress(100);
        data.processData = true;
        cb(null, data);
      }
      catch(err) {
        cb(new Error(err), null);
      }
      */
      cb(null, data);
    },

    uploadData(progress, data, cb) {
      /*

      var model = MODELS[data.model];
      if(model == null) {
        model = 'Unknown Bayer model';
      }
      debug('Detected as: ', model);

      progress(0);
      var sessionInfo = {
        deviceTags: ['bgm'],
        deviceManufacturers: ['Bayer'],
        deviceModel: model,
        deviceSerialNumber: data.serialNumber,
        deviceId: data.id,
        start: sundial.utcDateString(),
        timeProcessing: cfg.tzoUtil.type,
        tzName : cfg.timezone,
        version: cfg.version
      };

      cfg.api.upload.toPlatform(data.post_records, sessionInfo, progress, cfg.groupId, function (err, result) {
        progress(100);

        if (err) {
          debug(err);
          debug(result);
          return cb(err, data);
        } else {
          data.cleanup = true;
          return cb(null, data);
        }
      });
      */
      cb(null, data);
    },

    disconnect(progress, data, cb) {
      debug('in disconnect');
      cfg.deviceComms.removeListeners();
      // Due to an upstream bug in HIDAPI on Windoze, we have to send a command
      // to the device to ensure that the listeners are removed before we disconnect
      // For more details, see https://github.com/node-hid/node-hid/issues/61
      driver.hidDevice.send(TrueMetrix.buildPacket(0x04, 1), () => {
        progress(100);
        cb(null, data);
      });
    },

    cleanup(progress, data, cb) {
      debug('in cleanup');
      if (!data.disconnect) {
        cfg.deviceComms.disconnect(data, () => {
          progress(100);
          data.cleanup = true;
          data.disconnect = true;
          cb(null, data);
        });
      } else {
        progress(100);
      }
    },
  };
};
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChildProcessWithoutNullStreams } from 'child_process';
import { Camera, PropertyName } from 'eufy-security-client';
import {
  CameraController,
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  HDSProtocolSpecificErrorReason,
  PlatformAccessory,
  RecordingPacket,
} from 'homebridge';
import { EufySecurityPlatform } from '../platform';
import { CameraConfig } from '../utils/configTypes';
import { FFmpeg, FFmpegParameters } from '../utils/ffmpeg';
import { Logger } from '../utils/logger';
import net from 'net';
import { is_rtsp_ready } from '../utils/utils';
import { LocalLivestreamManager } from './LocalLivestreamManager';

const MAX_RECORDING_MINUTES = 3;

// TODO: proper motion reset

export class RecordingDelegate implements CameraRecordingDelegate {

  private platform: EufySecurityPlatform;
  private log: Logger;
  private camera: Camera;
  private cameraConfig: CameraConfig;
  private accessory: PlatformAccessory;

  private configuration?: CameraRecordingConfiguration;

  private forceStopTimeout?: NodeJS.Timeout;
  private closeReason?: number;
  private handlingStreamingRequest = false;

  private localLivestreamManager: LocalLivestreamManager;
  private controller?: CameraController;

  private session?: {
    socket: net.Socket;
    process?: ChildProcessWithoutNullStreams | undefined;
    generator: AsyncGenerator<{
        header: Buffer;
        length: number;
        type: string;
        data: Buffer;
    }, any, unknown>;
  };

  constructor(
    platform: EufySecurityPlatform,
    accessory: PlatformAccessory,
    device: Camera, cameraConfig:
    CameraConfig, livestreamManager: LocalLivestreamManager,
    log: Logger,
  ) {
    this.platform = platform;
    this.log = log;
    this.accessory = accessory;
    this.camera = device;
    this.cameraConfig = cameraConfig;
    this.localLivestreamManager = livestreamManager;
  }

  public setController(controller: CameraController) {
    this.controller = controller;
  }

  async * handleRecordingStreamRequest(streamId: number): AsyncGenerator<RecordingPacket, any, unknown> {
    this.handlingStreamingRequest = true;
    this.log.debug(this.camera.getName(), 'requesting recording for HomeKit Secure Video.');

    let cachedStreamId: number | undefined = undefined;
    
    let pending: Buffer[] = [];
    let filebuffer = Buffer.alloc(0);

    try {
      // eslint-disable-next-line max-len
      const audioEnabled = this.controller?.recordingManagement?.recordingManagementService.getCharacteristic(this.platform.Characteristic.RecordingAudioActive).value;
      if (audioEnabled) {
        this.log.debug('HKSV and plugin are set to record audio.');
      } else {
        this.log.debug('HKSV and plugin are set to omit audio recording.');
      }

      const videoParams = await FFmpegParameters.forVideoRecording();
      const audioParams = await FFmpegParameters.forAudioRecording();

      videoParams.setupForRecording(this.cameraConfig.videoConfig || {}, this.configuration!);
      audioParams.setupForRecording(this.cameraConfig.videoConfig || {}, this.configuration!);

      const rtsp = is_rtsp_ready(this.camera, this.cameraConfig, this.log);
      
      if (rtsp) {
        const url = this.camera.getPropertyValue(PropertyName.DeviceRTSPStreamUrl);
        this.platform.log.debug(this.camera.getName(), 'RTSP URL: ' + url);
        videoParams.setInputSource(url as string);
        audioParams.setInputSource(url as string);
      } else {
        const streamData = await this.localLivestreamManager.getLocalLivestream().catch((err) => {
          throw err;
        });
        await videoParams.setInputStream(streamData.videostream);
        await audioParams.setInputStream(streamData.audiostream);
        cachedStreamId = streamData.id;
      }

      const ffmpeg = new FFmpeg(
        `[${this.camera.getName()}] [HSV Recording Process]`,
        audioEnabled ? [videoParams, audioParams] : videoParams,
        this.log,
      );

      this.session = await ffmpeg.startFragmentedMP4Session();

      let timer = MAX_RECORDING_MINUTES * 60;
      if (this.platform.config.CameraMaxLivestreamDuration < timer) {
        timer = this.platform.config.CameraMaxLivestreamDuration;
      }

      if (timer > 0) {
        this.forceStopTimeout = setTimeout(() => {
          this.log.warn(
            this.camera.getName(),
            `The recording process has been running for ${timer} seconds and is now being forced closed!`,
          );

          this.accessory
            .getService(this.platform.Service.MotionSensor)?.getCharacteristic(this.platform.Characteristic.MotionDetected)
            .updateValue(false);
        }, timer * 1000);
      }

      for await (const box of this.session.generator) {
        const { header, type, data } = box;

        pending.push(header, data);

        const motionDetected = this.accessory
          .getService(this.platform.Service.MotionSensor)?.getCharacteristic(this.platform.Characteristic.MotionDetected).value;

        if (type === 'moov' || type === 'mdat') {
          const fragment = Buffer.concat(pending);

          filebuffer = Buffer.concat([filebuffer, Buffer.concat(pending)]);
          pending = [];

          yield {
            data: fragment,
            isLast: !motionDetected,
          };

          if (!motionDetected) {
            this.log.debug(this.camera.getName(), 'Ending recording session due to motion stopped!');
            break;
          }
        }
      }
    } catch (error) {
      this.log.error(this.camera.getName(), 'Error while recording: ' + error);
    } finally {
      if (this.closeReason && this.closeReason !== HDSProtocolSpecificErrorReason.NORMAL) {
        this.log.warn(
          this.camera.getName(),
          `The recording process was aborted by HSV with reason "${this.closeReason}"`,
        );
      } else if (filebuffer.length > 0) {
        this.log.debug(this.camera.getName(), 'Recording completed (HSV). Send ' + filebuffer.length + ' bytes.');
      }

      if (this.forceStopTimeout) {
        clearTimeout(this.forceStopTimeout);
        this.forceStopTimeout = undefined;
      }

      // check whether motion is still in progress
      const motionDetected = this.accessory
        .getService(this.platform.Service.MotionSensor)?.getCharacteristic(this.platform.Characteristic.MotionDetected).value;
      if (motionDetected) {
        this.accessory
          .getService(this.platform.Service.MotionSensor)?.getCharacteristic(this.platform.Characteristic.MotionDetected)
          .updateValue(false);
      }

      if (cachedStreamId) {
        this.localLivestreamManager.stopProxyStream(cachedStreamId);
      }
    }
  }

  updateRecordingActive(active: boolean): void {
    //this.log.debug(`Recording: ${active}`, this.accessory.displayName);
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.configuration = configuration;
  }

  closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {
    this.log.info(this.camera.getName(), 'Closing recording process');

    if (this.session) {
      this.log.debug(this.camera.getName(), 'Stopping recording session.');
      this.session.socket?.destroy();
      this.session.process?.kill('SIGKILL');
      this.session = undefined;
    } else {
      this.log.warn('Recording session could not be closed gracefully.');
    }

    if (this.forceStopTimeout) {
      clearTimeout(this.forceStopTimeout);
      this.forceStopTimeout = undefined;
    }

    this.closeReason = reason;
    this.handlingStreamingRequest = false;
  }

  acknowledgeStream(streamId) {
    this.log.debug('end of recording acknowledged!');
    this.closeRecordingStream(streamId, undefined);
  }
}
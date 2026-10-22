"""Prepare a private expression atlas using the pinned MIT LivePortrait models.

No driving videos, user pickle files, InsightFace models, or network requests.
The existing call player drives these frames using actual playback amplitude.
"""
import argparse
import contextlib
import json
import sys
from pathlib import Path


def prepare(root, source, destination):
    import cv2
    import numpy as np
    import torch
    from PIL import Image, ImageOps

    upstream = root / 'data/tools/liveportrait/upstream'
    sys.path.insert(0, str(upstream))
    from src.config.inference_config import InferenceConfig
    from src.live_portrait_wrapper import LivePortraitWrapper
    from src.utils.human_landmark_runner import LandmarkRunner
    from src.utils.crop import crop_image, prepare_paste_back, paste_back
    from src.utils.retargeting_utils import calc_eye_close_ratio

    # Bound decode size before allocating model input. Never accept an archive,
    # checkpoint or driving template from an agent.
    with Image.open(source) as opened:
        if opened.width * opened.height > 16_000_000:
            raise ValueError('Choose a portrait smaller than 16 megapixels.')
        image = ImageOps.exif_transpose(opened).convert('RGB')
        image.thumbnail((640, 640), Image.Resampling.LANCZOS)
        rgb = np.asarray(image)
    detector = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    faces = detector.detectMultiScale(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), 1.1, 5, minSize=(48, 48))
    if len(faces) != 1:
        raise ValueError('Choose a clear front-facing portrait with one face.')
    x, y, w, h = map(int, faces[0])
    size = round(max(w, h) * 1.6)
    left, top = round(x + w / 2 - size / 2), round(y + h / 2 - size / 2)
    # A square padded crop gives the upstream landmark runner its expected input.
    square = np.asarray(image.crop((left, top, left + size, top + size)))
    landmark = LandmarkRunner(ckpt_path=str(upstream / 'pretrained_weights/liveportrait/landmark.onnx'), onnx_provider='cpu')
    points = landmark.run(square) + np.array([left, top], dtype=np.float32)
    points = landmark.run(rgb, points)
    cropped = crop_image(rgb, points, dsize=512, scale=2.3, vy_ratio=-0.125)
    cfg = InferenceConfig(flag_force_cpu=not torch.cuda.is_available(), flag_use_half_precision=torch.cuda.is_available())
    wrapper = LivePortraitWrapper(cfg)
    prepared = wrapper.prepare_source(cropped['img_crop'])
    with torch.inference_mode():
        kp_info = wrapper.get_kp_info(prepared)
        feature = wrapper.extract_feature_3d(prepared)
        kp = wrapper.transform_keypoint(kp_info)
        mask = prepare_paste_back(cfg.mask_crop, cropped['M_c2o'], (image.width, image.height))
        eye_open = float(calc_eye_close_ratio(cropped['pt_crop'][None]).mean())
        eyes = [eye_open, eye_open * 0.4, 0.0]
        lips = [0.0, 0.07, 0.14, 0.23, 0.32, 0.42]
        atlas = Image.new('RGB', (image.width * len(lips), image.height * len(eyes)))
        for row, eye in enumerate(eyes):
            eye_delta = wrapper.retarget_eye(kp, wrapper.calc_combined_eye_ratio([[eye]], cropped['pt_crop']))
            for column, lip in enumerate(lips):
                lip_delta = wrapper.retarget_lip(kp, wrapper.calc_combined_lip_ratio([[lip]], cropped['pt_crop']))
                driving = wrapper.stitching(kp, kp + eye_delta + lip_delta)
                out = wrapper.parse_output(wrapper.warp_decode(feature, kp, driving)['out'])[0]
                frame = paste_back(out, cropped['M_c2o'], rgb, mask)
                atlas.paste(Image.fromarray(frame), (column * image.width, row * image.height))
    atlas.save(destination, 'WEBP', quality=88, method=4)
    return {'version': 1, 'columns': len(lips), 'rows': len(eyes), 'width': image.width, 'height': image.height,
            'engine': 'LivePortrait', 'animation': 'audio-amplitude-and-blink'}


if __name__ == '__main__':
    args = argparse.ArgumentParser()
    args.add_argument('--root', required=True)
    args.add_argument('--source', required=True)
    args.add_argument('--destination', required=True)
    parsed = args.parse_args()
    try:
        # Upstream diagnostics stay off the structured stdout protocol.
        with contextlib.redirect_stdout(sys.stderr):
            result = prepare(Path(parsed.root), Path(parsed.source), Path(parsed.destination))
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)

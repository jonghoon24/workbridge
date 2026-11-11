// 메시지·결과물 첨부의 업로드와 내려받기.
//
// 업로드는 세 단계다(서버 docs/domain/messaging-notifications.md "첨부 파일").
// 1. 백엔드 `<resource>/uploads`가 파일 정책(개수·크기·형식)을 검사하고 파일마다 서명 업로드 URL을 준다(api.js).
// 2. 브라우저가 각 URL에 파일을 저장소(Supabase Storage)로 직접 PUT한다. 백엔드를 거치지 않으므로
//    Vercel 요청 본문 4.5MB 한도에 걸리지 않는다.
// 3. 메시지·제출 요청에 돌려받은 업로드 id(`uploadIds`)를 보낸다.
//
// 2단계는 우리 백엔드가 아니라 저장소로 가는 요청이라 api.js(토큰을 붙이는 인스턴스)를 쓰지 않는다 —
// 액세스 토큰을 제3자에게 보내면 안 된다. 진행률 때문에 XMLHttpRequest를 쓴다.
import api from './api';
import { errorCode, fieldViolation, toUserMessage } from './errorMessages';

const UPLOAD_ERROR_TEXT = {
  413: '파일은 개당 10MB 이하여야 합니다.',
};

// 화면에 보여 줄 문구를 가진 오류. 컴포넌트는 err.displayMessage를 그대로 보여 준다.
function uploadError(message) {
  const error = new Error(message);
  error.displayMessage = message;
  return error;
}

function putFile(uploadUrl, file, mimeType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', mimeType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(file.size);
        resolve();
      } else {
        reject(uploadError(UPLOAD_ERROR_TEXT[xhr.status] || `파일을 올리지 못했습니다: ${file.name}. 다시 시도해 주세요.`));
      }
    };
    xhr.onerror = () => reject(uploadError(`파일을 올리지 못했습니다: ${file.name}. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.`));
    xhr.onabort = () => reject(uploadError('파일 업로드가 취소되었습니다.'));
    xhr.send(file);
  });
}

// 이미 올린 파일은 다시 올리지 않는다. 전송이 실패해 다시 보낼 때 같은 File의 업로드를 재사용한다
// (업로드는 2시간 동안 유효하고, 서버는 한 번 붙은 업로드를 다시 받지 않는다).
const uploadedFiles = new WeakMap();

export function forgetUploads(files) {
  files.forEach((file) => uploadedFiles.delete(file));
}

// 보낸 업로드를 서버가 거부했다(만료, 업로드 안 됨, 저장된 파일의 크기·형식, 업로드 목록 자체). 다음 시도에서 새로 올린다.
const REJECTED_UPLOAD_CODES = ['UPLOAD_NOT_FOUND', 'FILE_NOT_UPLOADED', 'FILE_TOO_LARGE', 'FILE_TYPE_UNSUPPORTED'];

export function isRejectedUpload(err) {
  return REJECTED_UPLOAD_CODES.includes(errorCode(err)) || fieldViolation(err)?.path === 'uploadIds';
}

/**
 * files를 resource(`/api/conversations/<id>` 또는 `/api/milestones/<id>`)에 붙일 수 있게 올리고
 * 업로드 id 목록을 돌려준다. onProgress(0~100)는 아직 올리지 않은 파일 바이트 기준이다.
 * 실패하면 displayMessage가 있는 오류를 던진다.
 */
export async function uploadAttachments(resource, files, onProgress = () => {}) {
  const pending = files.filter((file) => uploadedFiles.get(file)?.resource !== resource);
  if (pending.length > 0) {
    let issued;
    try {
      const { data } = await api.post(`${resource}/uploads`, {
        files: pending.map((file) => ({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
        })),
      });
      issued = data.uploads;
    } catch (err) {
      throw uploadError(toUserMessage(err, '파일 업로드를 준비하지 못했습니다.', {
        codes: { FILE_TOO_LARGE: UPLOAD_ERROR_TEXT[413] },
      }));
    }

    const total = pending.reduce((sum, file) => sum + file.size, 0) || 1;
    const loaded = pending.map(() => 0);
    const report = () => onProgress(Math.min(100, Math.round((loaded.reduce((a, b) => a + b, 0) / total) * 100)));
    report();

    await Promise.all(pending.map((file, index) => putFile(issued[index].uploadUrl, file, issued[index].mimeType, (bytes) => {
      loaded[index] = bytes;
      report();
    }).then(() => {
      uploadedFiles.set(file, { resource, id: issued[index].id });
    })));
  }
  return files.map((file) => uploadedFiles.get(file).id);
}

/**
 * 첨부를 내려받는다. 서명 URL은 짧게 살아서, 누를 때마다 다운로드 경로로 새 URL을 받는다.
 * downloadPath는 `/api/conversations/<id>/attachments/<id>/download` 같은 백엔드 경로다.
 */
export async function openAttachment(downloadPath) {
  const { data } = await api.get(downloadPath);
  if (data.expiresAt) {
    // 원래 이름으로 저장하라는 응답(Content-Disposition: attachment)이라 페이지를 떠나지 않는다.
    window.location.assign(data.url);
  } else {
    // 예전 공개 URL은 그대로 새 탭에서 연다.
    const opened = window.open(data.url, '_blank', 'noopener,noreferrer');
    if (!opened) window.location.assign(data.url);
  }
}

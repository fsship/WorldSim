export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function versionConflict() {
  return new ApiError(409, '存档版本已更新，请重新加载后再行动。');
}

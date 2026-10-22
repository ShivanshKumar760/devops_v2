export class AppError extends Error{
    /**
   * @param {string} message  safe to show to the client
   * @param {number} statusCode HTTP status
   * @param {Array<{field?: string, message: string}>} [details]
   */

    constructor(message,statusCode=500,details){
        super(message);
        this.name='AppError';
        this.statusCode=statusCode;
        this.details=details;
        // Error.captureStackTrace?.(this,this.constructor);
        Error.captureStackTrace?.(this, this.constructor);
    }
}
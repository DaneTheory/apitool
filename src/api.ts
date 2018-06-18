import Config from "./config";
import mergeConfig from "./config/merge";
import axios, { AxiosResponse, AxiosRequestConfig } from "axios";
import cloneDeep from "lodash.clonedeep";
import ResponseValidationContext, {
  ResultType
} from "./response_validation_context";
import Response from "./response";
import ErrorType from "./error_type";
import {
  get as getCancelToken,
  remove as removeCancelToken
} from "./cancel_token_manager";

interface ValidationResult {
  type: ResultType;
  data: any;
}

class Api {
  config: Config;

  static extend(config: Config) {
    return new Api(config);
  }

  constructor(config?: Config) {
    this.config = config || {};
  }

  extend(config: Config) {
    return new Api(mergeConfig(this.config, config));
  }

  headers(): any {
    if (!this.config.headers) {
      return undefined;
    }
    return Object.keys(this.config.headers!).reduce((acc: any, key: string) => {
      acc[key] = this.config.headers![key]();
      return acc;
    }, {});
  }

  transformData(data?: any) {
    if (!data) {
      return data;
    }
    return (this.config.transformData || []).reduce((acc, fn) => {
      return (acc = fn(acc));
    }, cloneDeep(data));
  }

  transformResponse(response?: any) {
    if (!response) {
      return response;
    }
    return (this.config.transformResponse || []).reduce((acc, fn) => {
      return (acc = fn(acc));
    }, cloneDeep(response));
  }

  buildAxiosConfig(
    method: string,
    url: string,
    data?: any
  ): AxiosRequestConfig {
    const transformedData = this.transformData(data);
    return {
      url,
      method,
      baseURL: this.config.baseURL,
      params: method == "get" ? transformedData : undefined,
      data: method != "get" ? transformedData : undefined,
      cancelToken: getCancelToken().token
    };
  }

  executeBefores() {
    (this.config.before || []).forEach(fn => fn());
  }

  executeAfters() {
    (this.config.after || []).forEach(fn => fn());
  }

  executeResponseValidations(response: AxiosResponse): ValidationResult {
    let type = ResultType.NO_ERROR,
      data;
    (this.config.responseValidations || []).every(responseValidation => {
      const responseValidationContext = new ResponseValidationContext();
      responseValidation(response, responseValidationContext);
      const result =
        responseValidationContext.resultType == ResultType.NO_ERROR;
      if (!result) {
        type = responseValidationContext.resultType;
        data = responseValidationContext.resultData;
      }
      return result;
    });
    return { type, data };
  }

  handleException(e: any): Response {
    if (axios.isCancel(e)) {
      return {
        error: true,
        errorType: ErrorType.GOT_CANCELED
      };
    } else {
      return {
        error: true,
        errorType: ErrorType.EXCEPTION,
        errorCode: e
      };
    }
  }

  async transformAndValidateResponse(
    response: AxiosResponse,
    method: string,
    url: string,
    data: any,
    retry: boolean,
    retryNum: number
  ): Promise<Response> {
    const transformedResponse = this.transformResponse(response.data);
    const validationResult = this.executeResponseValidations(response);
    const validationResultType = validationResult.type;
    const validationResultData = validationResult.data;
    let result;
    if (validationResultType == ResultType.RETRY) {
      if (!retry || (retry && retryNum > 0)) {
        const num = retry ? retryNum : validationResultData;
        result = await this.requestInternal(method, url, data, true, num - 1);
      } else {
        result = {
          error: true,
          errorType: ErrorType.RETRY_DONE_FAILED,
          errorCode: undefined,
          response: transformedResponse,
          orgResponse: response
        };
      }
    } else if (validationResultType == ResultType.CANCEL_ALL) {
      result = {
        error: true,
        errorType: ErrorType.CANCELED_ALL,
        errorCode: undefined,
        response: transformedResponse,
        orgResponse: response
      };
    } else if (validationResultType == ResultType.ERROR) {
      result = {
        error: true,
        errorType: ErrorType.USER_DEFINED_ERROR,
        errorCode: validationResultData,
        response: transformedResponse,
        orgResponse: response
      };
    } else if (validationResultType == ResultType.NO_ERROR) {
      result = {
        error: false,
        response: transformedResponse,
        orgResponse: response
      };
    } else {
      throw new Error(`validationResultType is ${validationResultType}.`);
    }
    return result;
  }

  async requestInternal(
    method: string,
    url: string,
    data: any,
    retry = false,
    retryNum = 0
  ): Promise<Response> {
    if (!retry) {
      this.executeBefores();
    }
    const config: AxiosRequestConfig = this.buildAxiosConfig(method, url, data);
    let response: AxiosResponse | undefined = undefined;
    let ret: Response | undefined = undefined;
    try {
      response = await axios.request(config);
    } catch (e) {
      ret = this.handleException(e);
    } finally {
      removeCancelToken(config.cancelToken);
    }
    if (!ret) {
      ret = await this.transformAndValidateResponse(
        response!,
        method,
        url,
        data,
        retry,
        retryNum
      );
    }
    if (!retry) {
      this.executeAfters();
    }
    return ret;
  }

  async request(method: string, url: string, data?: any): Promise<Response> {
    return await this.requestInternal(method, url, data);
  }
}

export default Api;

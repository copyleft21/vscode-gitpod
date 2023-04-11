import {
  CancellationTokenSource,
  ExtensionContext,
  Uri,
  ViewColumn,
  window,
  workspace,
} from "vscode";
import { AbstractWebview, WebviewPanelConfig } from "../abstract-webview";
import {
  FromDataExtensionsEditorMessage,
  ToDataExtensionsEditorMessage,
} from "../pure/interface-types";
import { ProgressUpdate } from "../progress";
import { QueryRunner } from "../queryRunner";
import {
  showAndLogExceptionWithTelemetry,
  showAndLogWarningMessage,
} from "../helpers";
import { extLogger } from "../common";
import { readFile, writeFile } from "fs-extra";
import { load as loadYaml } from "js-yaml";
import { DatabaseItem } from "../local-databases";
import { CodeQLCliServer } from "../cli";
import { asError, assertNever, getErrorMessage } from "../pure/helpers-pure";
import { ResolvableLocationValue } from "../pure/bqrs-cli-types";
import { showResolvableLocation } from "../interface-utils";
import { decodeBqrsToExternalApiUsages } from "./bqrs";
import { redactableError } from "../pure/errors";
import { readQueryResults, runQuery } from "./external-api-usage-query";
import { createDataExtensionYaml, loadDataExtensionYaml } from "./yaml";
import { ExternalApiUsage } from "./external-api-usage";
import { ModeledMethod } from "./modeled-method";

export class DataExtensionsEditorView extends AbstractWebview<
  ToDataExtensionsEditorMessage,
  FromDataExtensionsEditorMessage
> {
  public constructor(
    ctx: ExtensionContext,
    private readonly cliServer: CodeQLCliServer,
    private readonly queryRunner: QueryRunner,
    private readonly queryStorageDir: string,
    private readonly databaseItem: DatabaseItem,
  ) {
    super(ctx);
  }

  public async openView() {
    const panel = await this.getPanel();
    panel.reveal(undefined, true);

    await this.waitForPanelLoaded();
  }

  protected async getPanelConfig(): Promise<WebviewPanelConfig> {
    return {
      viewId: "data-extensions-editor",
      title: "Data Extensions Editor",
      viewColumn: ViewColumn.Active,
      preserveFocus: true,
      view: "data-extensions-editor",
    };
  }

  protected onPanelDispose(): void {
    // Nothing to do here
  }

  protected async onMessage(
    msg: FromDataExtensionsEditorMessage,
  ): Promise<void> {
    switch (msg.t) {
      case "viewLoaded":
        await this.onWebViewLoaded();

        break;
      case "jumpToUsage":
        await this.jumpToUsage(msg.location);

        break;
      case "saveModeledMethods":
        await this.saveModeledMethods(
          msg.externalApiUsages,
          msg.modeledMethods,
        );
        await this.loadExternalApiUsages();

        break;
      default:
        assertNever(msg);
    }
  }

  protected async onWebViewLoaded() {
    super.onWebViewLoaded();

    await Promise.all([
      this.loadExternalApiUsages(),
      this.loadExistingModeledMethods(),
    ]);
  }

  protected async jumpToUsage(
    location: ResolvableLocationValue,
  ): Promise<void> {
    try {
      await showResolvableLocation(location, this.databaseItem);
    } catch (e) {
      if (e instanceof Error) {
        if (e.message.match(/File not found/)) {
          void window.showErrorMessage(
            "Original file of this result is not in the database's source archive.",
          );
        } else {
          void extLogger.log(`Unable to handleMsgFromView: ${e.message}`);
        }
      } else {
        void extLogger.log(`Unable to handleMsgFromView: ${e}`);
      }
    }
  }

  protected async saveModeledMethods(
    externalApiUsages: ExternalApiUsage[],
    modeledMethods: Record<string, ModeledMethod>,
  ): Promise<void> {
    const modelFilename = this.calculateModelFilename();
    if (!modelFilename) {
      return;
    }

    const yaml = createDataExtensionYaml(externalApiUsages, modeledMethods);

    await writeFile(modelFilename, yaml);

    void extLogger.log(`Saved data extension YAML to ${modelFilename}`);
  }

  protected async loadExistingModeledMethods(): Promise<void> {
    const modelFilename = this.calculateModelFilename();
    if (!modelFilename) {
      return;
    }

    try {
      const yaml = await readFile(modelFilename, "utf8");

      const data = loadYaml(yaml, {
        filename: modelFilename,
      });

      const existingModeledMethods = loadDataExtensionYaml(data);

      if (!existingModeledMethods) {
        void showAndLogWarningMessage("Failed to parse data extension YAML.");
        return;
      }

      await this.postMessage({
        t: "setExistingModeledMethods",
        existingModeledMethods,
      });
    } catch (e: unknown) {
      void extLogger.log(`Unable to read data extension YAML: ${e}`);
    }
  }

  protected async loadExternalApiUsages(): Promise<void> {
    const cancellationTokenSource = new CancellationTokenSource();

    try {
      const queryResult = await runQuery({
        cliServer: this.cliServer,
        queryRunner: this.queryRunner,
        databaseItem: this.databaseItem,
        queryStorageDir: this.queryStorageDir,
        logger: extLogger,
        progress: (progressUpdate: ProgressUpdate) => {
          void this.showProgress(progressUpdate, 1500);
        },
        token: cancellationTokenSource.token,
      });
      if (!queryResult) {
        await this.clearProgress();
        return;
      }

      await this.showProgress({
        message: "Decoding results",
        step: 1100,
        maxStep: 1500,
      });

      const bqrsChunk = await readQueryResults({
        cliServer: this.cliServer,
        bqrsPath: queryResult.outputDir.bqrsPath,
        logger: extLogger,
      });
      if (!bqrsChunk) {
        await this.clearProgress();
        return;
      }

      await this.showProgress({
        message: "Finalizing results",
        step: 1450,
        maxStep: 1500,
      });

      const externalApiUsages = decodeBqrsToExternalApiUsages(bqrsChunk);

      await this.postMessage({
        t: "setExternalApiUsages",
        externalApiUsages,
      });

      await this.clearProgress();
    } catch (err) {
      void showAndLogExceptionWithTelemetry(
        redactableError(
          asError(err),
        )`Failed to load external APi usages: ${getErrorMessage(err)}`,
      );
    }
  }

  /*
   * Progress in this class is a bit weird. Most of the progress is based on running the query.
   * Query progress is always between 0 and 1000. However, we still have some steps that need
   * to be done after the query has finished. Therefore, the maximum step is 1500. This captures
   * that there's 1000 steps of the query progress since that takes the most time, and then
   * an additional 500 steps for the rest of the work. The progress doesn't need to be 100%
   * accurate, so this is just a rough estimate.
   */
  private async showProgress(update: ProgressUpdate, maxStep?: number) {
    await this.postMessage({
      t: "showProgress",
      step: update.step,
      maxStep: maxStep ?? update.maxStep,
      message: update.message,
    });
  }

  private async clearProgress() {
    await this.showProgress({
      step: 0,
      maxStep: 0,
      message: "",
    });
  }

  private calculateModelFilename(): string | undefined {
    const workspaceFolder = workspace.workspaceFolders?.find(
      (folder) => folder.name === "ql",
    );
    if (!workspaceFolder) {
      void extLogger.log("No workspace folder 'ql' found");

      return;
    }

    return Uri.joinPath(
      workspaceFolder.uri,
      "java/ql/lib/ext",
      `${this.databaseItem.name.replaceAll("/", ".")}.model.yml`,
    ).fsPath;
  }
}

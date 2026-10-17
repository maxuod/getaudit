import React from "react";
import {t, useUiLanguage, LanguageSwitch} from "./i18n.tsx";

function ConsoleError({error}: {error: Error}) {
  useUiLanguage();
  return (
    <main className="empty" role="alert">
      <LanguageSwitch/>
      <h1>{t("boundary.theInterfaceCouldNotBeDisplayed")}</h1>
      <p>{t("boundary.samplingRecordsAreStillSavedLocallyReloadTheInterfaceToCheck")}</p>
      <p>{error.name}: {error.message}</p>
      <button className="primary" onClick={() => location.reload()}>
        {t("boundary.reloadInterface")}
      </button>
    </main>
  );
}

export class ConsoleBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? <ConsoleError error={this.state.error}/> : this.props.children;
  }
}

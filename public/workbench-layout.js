// Width is the remaining workbench after the navigation pane, as on Desktop.
export function workbenchLayout({width,view,projectId,detailsOpen,settings,narrowProjectsOpen}) {
  const narrow=width<900,eligible=!settings&&(view==='all'||Boolean(projectId));
  const showDetails=!settings&&detailsOpen;
  return {narrow,eligible,showDetails,showList:!narrow||!showDetails,
    showProjects:eligible&&(!narrow||narrowProjectsOpen)&&!(narrow&&showDetails),
    projectsCommand:narrow&&eligible&&!showDetails,wideProjects:width>=1250};
}

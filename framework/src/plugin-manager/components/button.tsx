

export const Button: React.FC<
	React.PropsWithChildren<React.HTMLAttributes<HTMLAnchorElement>>
> = (props) => {
	const { children, className, ...other } = props;
	const wrapperClass = React.useMemo(() => {
		const is300 = APP_CONF.appver.startsWith('3.')
		if (!is300) return ""
		// 优先取顶栏里的按钮；页面上可能暂时没有任何 .cmd-button
		const cmdButton = document.querySelector('#page_pc_main_nav .cmd-button') ?? document.querySelector('.cmd-button')
		if (!cmdButton) return ""
		return [...(cmdButton.classList as unknown as string[])].find(v => v.startsWith('ButtonWrapper_')) ?? ""
	}, [])
	return (
		<a className={`${wrapperClass} u-ibtn5 u-ibtnsz8 cmd-button cmd-button-outlineSec cmd-button-size-m cmd-button-outline-sec button-item
		 ${className || ""}`} {...other}>
			{children}
		</a>
	);
};
